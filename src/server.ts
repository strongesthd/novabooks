import { createHash, createHmac } from "node:crypto";
import express, { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import path from "node:path";
import { config } from "./config";
import {
  AuthenticationError, TenantSelectionRequired, TenantUnavailableError, authenticate, loginUser, registerTenant, requireRoles, signAccessToken
} from "./auth";
import {
  connectChannel, getChannel, listChannels, registerTelegramWebhook, sendText, telegramRequest
} from "./channels";
import { decryptJson, hashWebhookKey, constantTimeEqual } from "./crypto";
import {
  closePool, pool, resolveWebhookChannel, withTenantTransaction, withWebhookTransaction
} from "./db";
import { startDailyReporter } from "./reporting";
import { DocumentValidationError, loadDocument } from "./storage";
import { AuthenticatedRequest, AuthContext, TenantRole } from "./types";
import {
  channelSchema, inviteSchema, loginSchema, productSchema, registerSchema, reviewSchema
} from "./validation";
import {
  createVoucherFromUpload, editVoucher, getVoucherDocument, HttpError, listVouchers,
  retryVoucherExtraction, reviewVoucher
} from "./vouchers";

type RawRequest = Request & { rawBody?: Buffer };
type InboundEvent = { channelId: string; eventId: string; file: Buffer; mimeType: string; size: number };

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 }
});

app.disable("x-powered-by");
app.set("trust proxy", config.NODE_ENV === "production" ? 1 : false);
app.use(helmet());
app.use(cors({ origin: config.APP_BASE_URL, credentials: false }));
app.use(express.json({
  limit: "1mb",
  verify: (req, _res, buffer) => { (req as RawRequest).rawBody = Buffer.from(buffer); }
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

app.get("/api/health", async (_req, res, next) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", service: "novabooks" });
  } catch (error) {
    next(error);
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "novabooks" });
});

app.post("/api/auth/register", authLimiter, async (req, res, next) => {
  try {
    const input = registerSchema.parse(req.body);
    const auth = await registerTenant(input);
    res.status(201).json({ token: signAccessToken(auth), user: { id: auth.userId }, tenant: { id: auth.tenantId, role: auth.role } });
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "Email hoặc mã tenant đã được đăng ký" });
      return;
    }
    if (error instanceof DocumentValidationError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.post("/api/auth/login", authLimiter, async (req, res, next) => {
  try {
    const input = loginSchema.parse(req.body);
    const auth = await loginUser(input.email, input.password, input.tenantId);
    res.json({ token: signAccessToken(auth), user: { id: auth.userId }, tenant: { id: auth.tenantId, role: auth.role } });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    if (error instanceof TenantUnavailableError) {
      res.status(403).json({ error: error.message });
      return;
    }
    if (error instanceof TenantSelectionRequired) {
      res.status(409).json({ error: error.message, memberships: error.memberships });
      return;
    }
    next(error);
  }
});

app.get("/api/auth/me", authenticate, async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const data = await withTenantTransaction(auth.tenantId, async (tx) => {
      const result = await tx.query(
        `SELECT u.id, u.email, u.full_name, m.role, t.id AS tenant_id, t.slug,
                t.name AS tenant_name, t.subscription_status, t.timezone, t.default_currency
         FROM users u
         JOIN tenant_memberships m ON m.user_id = u.id AND m.tenant_id = $1
         JOIN tenants t ON t.id = m.tenant_id
         WHERE u.id = $2 AND m.id = $3`,
        [auth.tenantId, auth.userId, auth.membershipId]
      );
      return result.rows[0];
    }, auth.userId);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.get("/api/dashboard", authenticate, async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const data = await withTenantTransaction(auth.tenantId, async (tx) => {
      const counts = await tx.query(
        `SELECT
           (SELECT count(*) FROM temp_vouchers
             WHERE status IN ('received','extracting','needs_review')
               AND ($1 <> 'staff' OR submitted_by_membership_id = $2))::int AS pending_vouchers,
           (SELECT count(*) FROM temp_vouchers
             WHERE status = 'posted' AND created_at >= date_trunc('month', now())
               AND ($1 <> 'staff' OR submitted_by_membership_id = $2))::int AS posted_this_month,
           CASE WHEN $1 = 'staff' THEN 0 ELSE (SELECT count(*) FROM suppliers)::int END AS suppliers,
           CASE WHEN $1 = 'staff' THEN 0 ELSE
             (SELECT count(*) FROM tenant_memberships WHERE status = 'active')::int END AS members`,
        [auth.role, auth.membershipId]
      );
      const currencies = await tx.query(
        `SELECT currency, COALESCE(sum(l.debit), 0)::text AS debit_total
         FROM accounting_entries e
         JOIN accounting_entry_lines l ON l.tenant_id = e.tenant_id AND l.accounting_entry_id = e.id
         WHERE e.status = 'posted' AND e.entry_date >= date_trunc('month', now())::date
           AND $1 <> 'staff'
         GROUP BY currency ORDER BY currency`,
        [auth.role]
      );
      return { ...counts.rows[0], month_totals: currencies.rows };
    }, auth.userId);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.get("/api/vouchers", authenticate, async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const vouchers = await withTenantTransaction(
      auth.tenantId,
      (tx) => listVouchers(tx, auth.role, auth.membershipId),
      auth.userId
    );
    res.json({ vouchers });
  } catch (error) {
    next(error);
  }
});

app.get("/api/vouchers/:voucherId/document", authenticate, async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const document = await withTenantTransaction(auth.tenantId, (tx) =>
      getVoucherDocument(tx, auth.tenantId, uuidParam(req.params.voucherId), auth.role, auth.membershipId), auth.userId);
    if (!document) throw new HttpError(404, "Không tìm thấy chứng từ trong tenant hiện tại");
    const body = await loadDocument(document.storageKey);
    res.set({
      "Cache-Control": "private, no-store",
      "Content-Disposition": "inline",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff"
    });
    res.type(document.mimeType).send(body);
  } catch (error) {
    next(error);
  }
});

app.post("/api/vouchers/upload", authenticate, upload.single("document"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    if (!req.file) throw new HttpError(400, "Vui lòng chọn tệp chứng từ");
    const voucher = await createVoucherFromUpload(auth, {
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      size: req.file.size
    });
    res.status(202).json({ voucherId: voucher.id, status: "received" });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/vouchers/:voucherId", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    await editVoucher(auth, uuidParam(req.params.voucherId), req.body);
    res.json({ status: "updated" });
  } catch (error) {
    next(error);
  }
});

app.post("/api/vouchers/:voucherId/retry", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    await retryVoucherExtraction(auth, uuidParam(req.params.voucherId));
    res.status(202).json({ status: "received" });
  } catch (error) {
    next(error);
  }
});

app.post("/api/vouchers/:voucherId/review", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const input = reviewSchema.parse(req.body);
    const result = await reviewVoucher(auth, uuidParam(req.params.voucherId), input.decision, input.note);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/entries", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const entries = await withTenantTransaction(auth.tenantId, async (tx) => {
      const result = await tx.query(
        `SELECT e.id, e.entry_number, e.entry_date, e.description, e.currency, e.status,
                COALESCE(sum(l.debit), 0)::text AS debit_total, e.created_at
         FROM accounting_entries e
         LEFT JOIN accounting_entry_lines l
           ON l.tenant_id = e.tenant_id AND l.accounting_entry_id = e.id
         GROUP BY e.tenant_id, e.id ORDER BY e.entry_date DESC, e.created_at DESC LIMIT 200`
      );
      return result.rows;
    }, auth.userId);
    res.json({ entries });
  } catch (error) {
    next(error);
  }
});

app.get("/api/channels", authenticate, requireRoles("tenant_admin"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    res.json({ channels: await withTenantTransaction(auth.tenantId, listChannels, auth.userId) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/channels", authenticate, requireRoles("tenant_admin"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    channelSchema.parse(req.body);
    const channel = await withTenantTransaction(
      auth.tenantId,
      (tx) => connectChannel(tx, auth, req.body),
      auth.userId
    );
    if (channel.telegramSetup) {
      try {
        await registerTelegramWebhook(
          channel.telegramSetup.token,
          channel.telegramSetup.secret,
          channel.webhookUrl
        );
      } catch (error) {
        await withTenantTransaction(auth.tenantId, async (tx) => {
          await tx.query(
            "UPDATE tenant_channels SET status = 'error', updated_at = now() WHERE tenant_id = $1 AND id = $2",
            [auth.tenantId, channel.channelId]
          );
        }, auth.userId);
        throw error;
      }
    }
    const { telegramSetup: _telegramSetup, ...publicChannel } = channel;
    res.status(201).json(publicChannel);
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "Tài khoản kênh này đã được kết nối với một tenant" });
      return;
    }
    next(error);
  }
});

app.post("/api/channels/:channelId/disable", authenticate, requireRoles("tenant_admin"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    await withTenantTransaction(auth.tenantId, async (tx) => {
      const result = await tx.query(
        `UPDATE tenant_channels SET status = 'disabled', updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND status <> 'disabled'`,
        [auth.tenantId, uuidParam(req.params.channelId)]
      );
      if (!result.rowCount) throw new HttpError(404, "Không tìm thấy kênh");
      await tx.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id)
         VALUES ($1, $2, 'channel.disabled', 'tenant_channel', $3)`,
        [auth.tenantId, auth.userId, uuidParam(req.params.channelId)]
      );
    }, auth.userId);
    res.json({ status: "disabled" });
  } catch (error) {
    next(error);
  }
});

app.post("/api/channels/:channelId/retry-webhook", authenticate, requireRoles("tenant_admin"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const channel = await withTenantTransaction(auth.tenantId, async (tx) => {
      const result = await tx.query<{
        provider: string;
        status: string;
        credentials_ciphertext: Buffer;
      }>(
        `SELECT provider, status, credentials_ciphertext FROM tenant_channels
         WHERE tenant_id = $1 AND id = $2`,
        [auth.tenantId, uuidParam(req.params.channelId)]
      );
      return result.rows[0] ?? null;
    }, auth.userId);
    if (!channel || channel.provider !== "telegram" || !["error", "disabled"].includes(channel.status)) {
      throw new HttpError(404, "Không tìm thấy Telegram channel cần đăng ký lại webhook");
    }
    const credentials = decryptJson(channel.credentials_ciphertext);
    const token = stringValue(credentials.token);
    const secret = stringValue(credentials.webhookSecret);
    const routeKey = stringValue(credentials.routeKey);
    const webhookUrl = `${config.APP_BASE_URL}/webhooks/telegram/${routeKey}`;
    await registerTelegramWebhook(token, secret, webhookUrl);
    await withTenantTransaction(auth.tenantId, async (tx) => {
      await tx.query(
        "UPDATE tenant_channels SET status = 'active', last_verified_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2",
        [auth.tenantId, uuidParam(req.params.channelId)]
      );
      await tx.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id)
         VALUES ($1, $2, 'channel.webhook_retried', 'tenant_channel', $3)`,
        [auth.tenantId, auth.userId, uuidParam(req.params.channelId)]
      );
    }, auth.userId);
    res.json({ status: "active", webhookUrl });
  } catch (error) {
    next(error);
  }
});

app.get("/api/members", authenticate, requireRoles("tenant_admin"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const members = await withTenantTransaction(auth.tenantId, async (tx) => {
      const result = await tx.query(
        `SELECT m.id, m.user_id, m.role, m.status, m.created_at, u.email, u.full_name
         FROM tenant_memberships m JOIN users u ON u.id = m.user_id
         ORDER BY m.created_at`
      );
      return result.rows;
    }, auth.userId);
    res.json({ members });
  } catch (error) {
    next(error);
  }
});

app.post("/api/members", authenticate, requireRoles("tenant_admin"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const input = inviteSchema.parse(req.body);
    const result = await withTenantTransaction(auth.tenantId, async (tx) => {
      const user = await tx.query<{ id: string }>("SELECT id FROM users WHERE email = $1 LIMIT 1", [input.email]);
      const targetUserId = user.rows[0]?.id;
      if (!targetUserId) throw new HttpError(404, "Người dùng cần tạo tài khoản NovaBooks trước khi được thêm vào tenant");
      const membership = await tx.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role, status, invited_by_user_id, invited_at, joined_at)
         VALUES ($1, $2, $3, 'active', $4, now(), now())
         ON CONFLICT (tenant_id, user_id) DO UPDATE
           SET role = EXCLUDED.role, status = 'active', invited_by_user_id = EXCLUDED.invited_by_user_id,
               invited_at = now(), joined_at = now(), updated_at = now()
           WHERE tenant_memberships.status IN ('removed', 'suspended')
         RETURNING id, role, status`,
        [auth.tenantId, targetUserId, input.role, auth.userId]
      );
      const newMembership = membership.rows[0];
      if (!newMembership) throw new HttpError(409, "Người dùng đã thuộc tenant này");
      await tx.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id)
         VALUES ($1, $2, 'membership.created', 'tenant_membership', $3)`,
        [auth.tenantId, auth.userId, newMembership.id]
      );
      return newMembership;
    }, auth.userId);
    res.status(201).json(result);
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "Người dùng đã thuộc tenant này" });
      return;
    }
    next(error);
  }
});

app.post("/api/members/:membershipId/remove", authenticate, requireRoles("tenant_admin"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    await withTenantTransaction(auth.tenantId, async (tx) => {
      const target = await tx.query<{ role: string; user_id: string; status: string }>(
        "SELECT role, user_id, status FROM tenant_memberships WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [auth.tenantId, uuidParam(req.params.membershipId)]
      );
      const member = target.rows[0];
      if (!member || member.status === "removed") throw new HttpError(404, "Không tìm thấy thành viên đang hoạt động");
      if (member.role === "tenant_admin") {
        const admins = await tx.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM tenant_memberships WHERE tenant_id = $1 AND role = 'tenant_admin' AND status = 'active'",
          [auth.tenantId]
        );
        if (Number(admins.rows[0]?.count ?? 0) <= 1) {
          throw new HttpError(409, "Không thể gỡ Tenant Admin cuối cùng");
        }
      }
      await tx.query(
        "UPDATE tenant_memberships SET status = 'removed', updated_at = now() WHERE tenant_id = $1 AND id = $2",
        [auth.tenantId, uuidParam(req.params.membershipId)]
      );
      await tx.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id)
         VALUES ($1, $2, 'membership.removed', 'tenant_membership', $3)`,
        [auth.tenantId, auth.userId, uuidParam(req.params.membershipId)]
      );
    }, auth.userId);
    res.json({ status: "removed" });
  } catch (error) {
    next(error);
  }
});

app.get("/api/suppliers", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const suppliers = await withTenantTransaction(auth.tenantId, async (tx) => {
      const result = await tx.query("SELECT id, code, name, tax_id, email FROM suppliers ORDER BY name LIMIT 500");
      return result.rows;
    }, auth.userId);
    res.json({ suppliers });
  } catch (error) {
    next(error);
  }
});

app.post("/api/suppliers", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const input = validateSupplier(req.body);
    const supplier = await withTenantTransaction(auth.tenantId, async (tx) => {
      const result = await tx.query(
        "INSERT INTO suppliers (tenant_id, code, name, tax_id, email) VALUES ($1, $2, $3, $4, $5) RETURNING id, code, name, tax_id, email",
        [auth.tenantId, input.code, input.name, input.taxId ?? null, input.email ?? null]
      );
      return result.rows[0];
    }, auth.userId);
    res.status(201).json(supplier);
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "Mã hoặc mã số thuế nhà cung cấp đã tồn tại" });
      return;
    }
    next(error);
  }
});

app.get("/api/products", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const products = await withTenantTransaction(auth.tenantId, async (tx) => {
      const result = await tx.query(
        `SELECT id, code, name, unit, default_unit_price, currency, tax_rate, status
         FROM products ORDER BY name LIMIT 500`
      );
      return result.rows;
    }, auth.userId);
    res.json({ products });
  } catch (error) {
    next(error);
  }
});

app.post("/api/products", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const input = productSchema.parse(req.body);
    const product = await withTenantTransaction(auth.tenantId, async (tx) => {
      const result = await tx.query(
        `INSERT INTO products
           (tenant_id, code, name, unit, default_unit_price, currency, tax_rate)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, code, name, unit, default_unit_price, currency, tax_rate, status`,
        [
          auth.tenantId, input.code, input.name, input.unit ?? null,
          input.defaultUnitPrice ?? null, input.currency, input.taxRate ?? null
        ]
      );
      return result.rows[0];
    }, auth.userId);
    res.status(201).json(product);
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "Mã sản phẩm đã tồn tại trong tenant này" });
      return;
    }
    next(error);
  }
});

app.get("/api/reports", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const reports = await withTenantTransaction(auth.tenantId, async (tx) => {
      const result = await tx.query(
        "SELECT id, report_date, channel_id, status, summary, error_code, created_at FROM report_runs ORDER BY created_at DESC LIMIT 100"
      );
      return result.rows;
    }, auth.userId);
    res.json({ reports });
  } catch (error) {
    next(error);
  }
});

app.post("/webhooks/telegram/:routeKey", async (req, res, next) => {
  try {
    const resolved = await resolveWebhookChannel(hashWebhookKey(req.params.routeKey));
    if (!resolved) {
      res.sendStatus(404);
      return;
    }
    const event = await withWebhookTransaction(resolved.tenantId, async (tx) => {
      const channel = await getChannel(resolved.tenantId, resolved.channelId, tx);
      if (!channel || channel.provider !== "telegram") return null;
      const credentials = decryptJson(channel.credentials_ciphertext);
      const expected = stringValue(credentials.webhookSecret);
      const actual = req.header("x-telegram-bot-api-secret-token") ?? "";
      if (!constantTimeEqual(expected, actual)) return null;
      return { channel, credentials };
    });
    if (!event) {
      res.sendStatus(401);
      return;
    }
    const inbound = await receiveTelegramDocument(req.body, event.channel.config, event.credentials, resolved.channelId);
    if (!inbound) {
      res.sendStatus(200);
      return;
    }
    const accepted = await acceptInbound(resolved.tenantId, inbound);
    res.status(accepted ? 202 : 200).json({ accepted });
  } catch (error) {
    next(error);
  }
});

app.post("/webhooks/zalo/:routeKey", async (req, res, next) => {
  try {
    const resolved = await resolveWebhookChannel(hashWebhookKey(req.params.routeKey));
    if (!resolved) {
      res.sendStatus(404);
      return;
    }
    const event = await withWebhookTransaction(resolved.tenantId, async (tx) => {
      const channel = await getChannel(resolved.tenantId, resolved.channelId, tx);
      if (!channel || channel.provider !== "zalo_oa") return null;
      const credentials = decryptJson(channel.credentials_ciphertext);
      const appSecret = stringValue(credentials.appSecret);
      const supplied = (req.header("x-zevent-signature") ?? "").replace(/^mac=/, "");
      const expected = createHmac("sha256", appSecret).update((req as RawRequest).rawBody ?? Buffer.alloc(0)).digest("hex");
      if (!constantTimeEqual(expected.toLowerCase(), supplied.toLowerCase())) return null;
      return { channel, credentials };
    });
    if (!event) {
      res.sendStatus(401);
      return;
    }
    const inbound = await receiveZaloDocument(req.body, event.channel, event.credentials, resolved.channelId);
    if (!inbound) {
      res.sendStatus(200);
      return;
    }
    const accepted = await acceptInbound(resolved.tenantId, inbound);
    res.status(accepted ? 202 : 200).json({ accepted });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.resolve(__dirname, "../public"), { index: "index.html", maxAge: "1h" }));

app.use((req, res) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/webhooks/")) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.sendFile(path.resolve(__dirname, "../public/index.html"));
});

const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof multer.MulterError) {
    res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
      .json({ error: error.code === "LIMIT_FILE_SIZE" ? "Tệp vượt quá giới hạn dung lượng" : error.message });
    return;
  }
  if (error instanceof SyntaxError && "body" in error) {
    res.status(400).json({ error: "JSON request không hợp lệ" });
    return;
  }
  if (error && typeof error === "object" && "name" in error && error.name === "ZodError") {
    res.status(400).json({ error: "Dữ liệu đầu vào không hợp lệ", details: (error as { issues?: unknown }).issues });
    return;
  }
  console.error("request failed", {
    error: error instanceof Error ? error.message : "unknown error"
  });
  res.status(500).json({ error: "Lỗi hệ thống; vui lòng thử lại sau" });
};
app.use(errorHandler);

function validateSupplier(input: unknown): { code: string; name: string; taxId?: string; email?: string } {
  if (!input || typeof input !== "object") throw new HttpError(400, "Dữ liệu nhà cung cấp không hợp lệ");
  const value = input as Record<string, unknown>;
  if (typeof value.code !== "string" || value.code.trim().length < 1 || value.code.length > 64
    || typeof value.name !== "string" || value.name.trim().length < 2 || value.name.length > 200) {
    throw new HttpError(400, "Mã và tên nhà cung cấp là bắt buộc");
  }
  if (value.taxId !== undefined && typeof value.taxId !== "string") throw new HttpError(400, "Mã số thuế không hợp lệ");
  if (value.email !== undefined && typeof value.email !== "string") throw new HttpError(400, "Email không hợp lệ");
  return {
    code: value.code.trim(),
    name: value.name.trim(),
    taxId: value.taxId as string | undefined,
    email: value.email as string | undefined
  };
}

async function receiveTelegramDocument(
  body: unknown,
  channelConfig: Record<string, unknown>,
  credentials: Record<string, unknown>,
  channelId: string
): Promise<InboundEvent | null> {
  const update = body as {
    update_id?: number;
    message?: { chat?: { id?: number | string }; photo?: Array<{ file_id: string }>; document?: { file_id: string; mime_type?: string; file_size?: number } };
  };
  if (typeof update?.update_id !== "number" || !update.message?.chat?.id) throw new HttpError(400, "Telegram update không hợp lệ");
  if (String(update.message.chat.id) !== String(channelConfig.chatId)) return null;
  const image = update.message.photo?.at(-1);
  const document = update.message.document;
  const fileId = image?.file_id ?? document?.file_id;
  if (!fileId) return null;

  const token = stringValue(credentials.token);
  const meta = await telegramRequest(token, "getFile", { file_id: fileId });
  const filePath = meta.result?.file_path;
  if (!meta.ok || typeof filePath !== "string") throw new Error("Telegram không trả về đường dẫn tệp");
  const response = await fetch(
    `${config.TELEGRAM_BOT_API_BASE_URL}/file/bot${token}/${filePath}`,
    { redirect: "error", signal: AbortSignal.timeout(30_000) }
  );
  if (!response.ok) throw new Error(`Tải tệp Telegram thất bại (${response.status})`);
  const buffer = await readLimitedResponse(response);
  const mimeType = response.headers.get("content-type")?.split(";")[0]
    ?? document?.mime_type ?? "image/jpeg";
  return { channelId, eventId: String(update.update_id), file: buffer, mimeType, size: buffer.length };
}

async function receiveZaloDocument(
  body: unknown,
  channel: { id: string; external_account_id: string | null },
  _credentials: Record<string, unknown>,
  channelId: string
): Promise<InboundEvent | null> {
  const event = body as {
    oa_id?: string | number;
    event_name?: string;
    timestamp?: string | number;
    message?: {
      msg_id?: string;
      attachments?: Array<{ type?: string; payload?: { url?: string } }>;
    };
  };
  if (String(event?.oa_id ?? "") !== String(channel.external_account_id ?? "")) {
    throw new HttpError(400, "Zalo OA ID không khớp cấu hình channel");
  }
  const attachment = event.message?.attachments?.find((item) => item.type === "image" && item.payload?.url);
  if (!attachment?.payload?.url) return null;
  const eventId = event.message?.msg_id ?? `${event.event_name ?? "event"}:${event.timestamp ?? ""}`;
  if (!eventId || eventId.endsWith(":")) throw new HttpError(400, "Zalo webhook thiếu event ID");
  const mediaUrl = new URL(attachment.payload.url);
  const allowedHost = ["zalo.me", "zadn.vn", "zaloapp.com"].some((suffix) =>
    mediaUrl.hostname === suffix || mediaUrl.hostname.endsWith(`.${suffix}`)
  );
  if (mediaUrl.protocol !== "https:" || !allowedHost || mediaUrl.username || mediaUrl.password) {
    throw new HttpError(400, "URL ảnh từ Zalo không thuộc domain được phép");
  }
  const response = await fetch(mediaUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`Tải ảnh Zalo thất bại (${response.status})`);
  const buffer = await readLimitedResponse(response);
  const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
  return { channelId, eventId, file: buffer, mimeType, size: buffer.length };
}

async function readLimitedResponse(response: globalThis.Response): Promise<Buffer> {
  const maximum = config.MAX_UPLOAD_MB * 1024 * 1024;
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maximum) {
    await response.body?.cancel();
    throw new HttpError(413, "Tệp vượt quá giới hạn dung lượng");
  }
  if (!response.body) throw new Error("Provider returned an empty file response");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new HttpError(413, "Tệp vượt quá giới hạn dung lượng");
    }
    chunks.push(Buffer.from(value));
  }
  if (!total) throw new Error("Provider returned an empty file response");
  return Buffer.concat(chunks, total);
}

async function acceptInbound(tenantId: string, inbound: InboundEvent): Promise<boolean> {
  const payloadHash = createHash("sha256").update(inbound.file).digest();
  const event = await withWebhookTransaction(tenantId, async (tx) => {
    const inserted = await tx.query<{ id: string; processing_status: string }>(
      `INSERT INTO ingestion_events (tenant_id, channel_id, provider_event_id, payload_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, channel_id, provider_event_id)
       DO UPDATE SET processing_status = 'processing'
         WHERE ingestion_events.processing_status = 'failed'
       RETURNING id, processing_status`,
      [tenantId, inbound.channelId, inbound.eventId, payloadHash]
    );
    return inserted.rows[0] ?? null;
  });
  if (!event) return false;
  const alreadyVoucher = await withWebhookTransaction(tenantId, async (tx) => {
    const result = await tx.query(
      "SELECT 1 FROM temp_vouchers WHERE tenant_id = $1 AND source_event_id = $2",
      [tenantId, event.id]
    );
    return result.rowCount !== 0;
  });
  if (alreadyVoucher) {
    await withWebhookTransaction(tenantId, async (tx) => {
      await tx.query(
        "UPDATE ingestion_events SET processing_status = 'processed', processed_at = COALESCE(processed_at, now()) WHERE tenant_id = $1 AND id = $2",
        [tenantId, event.id]
      );
    });
    return false;
  }

  try {
    const auth: AuthContext = { tenantId, userId: "", membershipId: "", role: "staff" };
    await createVoucherFromUpload(auth, {
      buffer: inbound.file,
      mimeType: inbound.mimeType,
      size: inbound.size
    }, { channelId: inbound.channelId, eventId: event.id });
    await withWebhookTransaction(tenantId, async (tx) => {
      await tx.query(
        "UPDATE ingestion_events SET processing_status = 'processed', processed_at = now() WHERE tenant_id = $1 AND id = $2",
        [tenantId, event.id]
      );
    });
    return true;
  } catch (error) {
    await withWebhookTransaction(tenantId, async (tx) => {
      await tx.query(
        "UPDATE ingestion_events SET processing_status = 'failed', last_error_code = 'voucher_create_failed' WHERE tenant_id = $1 AND id = $2",
        [tenantId, event.id]
      );
    });
    throw error;
  }
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Webhook credential is missing");
  return value;
}

function uuidParam(value: string | string[] | undefined): string {
  const id = Array.isArray(value) ? value[0] : value;
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new HttpError(400, "Định danh tài nguyên không hợp lệ");
  }
  return id;
}

function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "23505";
}

async function start(): Promise<void> {
  await pool.query("SELECT 1");
  startDailyReporter();
  const server = app.listen(config.PORT, config.HOST, () => {
    console.log(`NovaBooks listening on http://${config.HOST}:${config.PORT}`);
  });
  const shutdown = () => {
    server.close(() => {
      void closePool().then(() => process.exit(0)).catch((error: unknown) => {
        console.error("database shutdown failed", error);
        process.exit(1);
      });
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void start().catch((error: unknown) => {
  console.error("NovaBooks startup failed", error);
  process.exitCode = 1;
});
