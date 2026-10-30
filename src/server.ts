import { createHash, createHmac, randomUUID } from "node:crypto";
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
import { createLedgerTemplate, LedgerWorkbookError, parseLedgerWorkbook } from "./ledger";
import { DocumentValidationError, loadDocument } from "./storage";
import { AuthenticatedRequest, AuthContext, TenantRole } from "./types";
import {
  channelSchema, inviteSchema, ledgerMappingSchema, loginSchema, productSchema, registerSchema, reviewSchema,
  supplierSchema
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
    const result = await reviewVoucher(
      auth, uuidParam(req.params.voucherId), input.decision, input.note, input.accountMappings
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/entries", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const options = parseListOptions(req);
    const result = await withTenantTransaction(auth.tenantId, async (tx) => {
      const count = await tx.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM accounting_entries
         WHERE ($1 = '' OR entry_number ILIKE '%' || $1 || '%' OR description ILIKE '%' || $1 || '%')`,
        [options.search]
      );
      const entries = await tx.query(
        `SELECT e.id, e.entry_number, e.entry_date, e.description, e.currency, e.status,
                e.reverses_entry_id,
                (SELECT r.id FROM accounting_entries r
                 WHERE r.tenant_id = e.tenant_id AND r.reverses_entry_id = e.id) AS reversal_entry_id,
                COALESCE(sum(l.debit), 0)::text AS debit_total, e.created_at
         FROM accounting_entries e
         LEFT JOIN accounting_entry_lines l
           ON l.tenant_id = e.tenant_id AND l.accounting_entry_id = e.id
         WHERE ($1 = '' OR e.entry_number ILIKE '%' || $1 || '%' OR e.description ILIKE '%' || $1 || '%')
         GROUP BY e.tenant_id, e.id
         ORDER BY e.entry_date DESC, e.created_at DESC
         LIMIT $2 OFFSET $3`,
        [options.search, options.pageSize, options.offset]
      );
      return { entries: entries.rows, total: Number(count.rows[0]?.total ?? 0) };
    }, auth.userId);
    res.json({ ...result, page: options.page, pageSize: options.pageSize });
  } catch (error) {
    next(error);
  }
});

app.post("/api/entries/:entryId/reverse", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const entryId = uuidParam(req.params.entryId);
    const reversal = await withTenantTransaction(auth.tenantId, async (tx) => {
      const sourceResult = await tx.query<{
        id: string;
        entry_number: string;
        description: string;
        currency: string;
        status: string;
        reverses_entry_id: string | null;
      }>(
        `SELECT id, entry_number, description, currency, status, reverses_entry_id
         FROM accounting_entries WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [auth.tenantId, entryId]
      );
      const source = sourceResult.rows[0];
      if (!source) throw new HttpError(404, "Không tìm thấy bút toán trong tenant hiện tại");
      if (source.status !== "posted" || source.reverses_entry_id) {
        throw new HttpError(409, "Chỉ có thể lập bút toán đảo cho bút toán gốc đã hạch toán");
      }
      const existing = await tx.query(
        "SELECT id FROM accounting_entries WHERE tenant_id = $1 AND reverses_entry_id = $2",
        [auth.tenantId, entryId]
      );
      if (existing.rowCount) throw new HttpError(409, "Bút toán này đã có bút toán đảo");
      const lines = await tx.query<{
        line_number: number;
        account_code: string;
        account_name: string;
        description: string | null;
        debit: string;
        credit: string;
      }>(
        `SELECT line_number, account_code, account_name, description, debit::text, credit::text
         FROM accounting_entry_lines
         WHERE tenant_id = $1 AND accounting_entry_id = $2 ORDER BY line_number`,
        [auth.tenantId, entryId]
      );
      if (lines.rows.length < 2) throw new HttpError(409, "Không thể đảo bút toán thiếu dòng hạch toán");

      const reversalId = randomUUID();
      const reversalNumber = `REV-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${reversalId.slice(0, 8).toUpperCase()}`;
      await tx.query(
        `INSERT INTO accounting_entries
           (tenant_id, id, reverses_entry_id, entry_number, entry_date, description, currency,
            status, created_by_membership_id, posted_by_membership_id, posted_at)
         VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, $6, 'draft', $7, NULL, NULL)`,
        [
          auth.tenantId, reversalId, entryId, reversalNumber,
          `Đảo bút toán ${source.entry_number}`, source.currency, auth.membershipId
        ]
      );
      for (const [index, line] of lines.rows.entries()) {
        await tx.query(
          `INSERT INTO accounting_entry_lines
             (tenant_id, accounting_entry_id, line_number, account_code, account_name,
              description, debit, credit)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            auth.tenantId, reversalId, index + 1, line.account_code, line.account_name,
            line.description, line.credit, line.debit
          ]
        );
      }
      await tx.query(
        `UPDATE accounting_entries
         SET status = 'posted', posted_by_membership_id = $3, posted_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND status = 'draft'`,
        [auth.tenantId, reversalId, auth.membershipId]
      );
      await tx.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, $2, 'accounting_entry.reversed', 'accounting_entry', $3, $4)`,
        [auth.tenantId, auth.userId, reversalId, JSON.stringify({ reversesEntryId: entryId })]
      );
      return { id: reversalId, entryNumber: reversalNumber };
    }, auth.userId);
    res.status(201).json({ status: "reversed", ...reversal });
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "Bút toán này đã có bút toán đảo" });
      return;
    }
    next(error);
  }
});

app.get("/api/ledger/template", authenticate, requireRoles("tenant_admin", "accountant"), async (_req, res, next) => {
  try {
    const workbook = await createLedgerTemplate();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="novabooks-ledger-template.xlsx"');
    res.send(workbook);
  } catch (error) {
    next(error);
  }
});

app.post("/api/ledger/import/preview", authenticate, requireRoles("tenant_admin", "accountant"), upload.single("ledger"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const workbook = await parseLedgerUpload(req.file);
    const entryNumbers = workbook.entries.map((entry) => entry.entryNumber);
    const duplicates = await withTenantTransaction(auth.tenantId, async (tx) => {
      const result = await tx.query<{ entry_number: string }>(
        "SELECT entry_number FROM accounting_entries WHERE entry_number = ANY($1::text[])",
        [entryNumbers]
      );
      return result.rows.map((row) => row.entry_number);
    }, auth.userId);
    res.json({
      entryCount: workbook.entries.length,
      lineCount: workbook.lineCount,
      accountCount: workbook.accounts.length,
      duplicateEntryNumbers: duplicates,
      canImport: duplicates.length === 0
    });
  } catch (error) {
    if (error instanceof LedgerWorkbookError) {
      res.status(400).json({ error: error.message, details: error.details });
      return;
    }
    next(error);
  }
});

app.post("/api/ledger/import", authenticate, requireRoles("tenant_admin", "accountant"), upload.single("ledger"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const workbook = await parseLedgerUpload(req.file);
    const result = await withTenantTransaction(auth.tenantId, async (tx) => {
      const entryNumbers = workbook.entries.map((entry) => entry.entryNumber);
      const duplicates = await tx.query<{ entry_number: string }>(
        "SELECT entry_number FROM accounting_entries WHERE entry_number = ANY($1::text[])",
        [entryNumbers]
      );
      if (duplicates.rowCount) {
        throw new HttpError(409, `Số bút toán đã tồn tại: ${duplicates.rows.map((row) => row.entry_number).join(", ")}`);
      }

      for (const account of workbook.accounts) {
        await tx.query(
          `INSERT INTO ledger_accounts (tenant_id, account_code, account_name)
           VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, account_code)
           DO UPDATE SET account_name = EXCLUDED.account_name, updated_at = now()`,
          [auth.tenantId, account.accountCode, account.accountName]
        );
      }

      for (const entry of workbook.entries) {
        const entryId = randomUUID();
        await tx.query(
          `INSERT INTO accounting_entries
             (tenant_id, id, entry_number, entry_date, description, currency, status,
              created_by_membership_id, posted_by_membership_id, posted_at)
           VALUES ($1, $2, $3, $4::date, $5, $6, 'draft', $7, NULL, NULL)`,
          [
            auth.tenantId, entryId, entry.entryNumber, entry.entryDate,
            entry.description, entry.currency, auth.membershipId
          ]
        );
        for (const [index, line] of entry.lines.entries()) {
          await tx.query(
            `INSERT INTO accounting_entry_lines
               (tenant_id, accounting_entry_id, line_number, account_code, account_name,
                description, debit, credit)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              auth.tenantId, entryId, index + 1, line.accountCode, line.accountName,
              line.description, line.debit, line.credit
            ]
          );
        }
        await tx.query(
          `UPDATE accounting_entries
           SET status = 'posted', posted_by_membership_id = $3, posted_at = now(), updated_at = now()
           WHERE tenant_id = $1 AND id = $2 AND status = 'draft'`,
          [auth.tenantId, entryId, auth.membershipId]
        );
      }

      await tx.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, details)
         VALUES ($1, $2, 'ledger.imported', 'accounting_entries', $3)`,
        [auth.tenantId, auth.userId, JSON.stringify({
          entryCount: workbook.entries.length,
          lineCount: workbook.lineCount,
          accountCount: workbook.accounts.length
        })]
      );
      return {
        entryCount: workbook.entries.length,
        lineCount: workbook.lineCount,
        accountCount: workbook.accounts.length
      };
    }, auth.userId);
    res.status(201).json({ status: "imported", ...result });
  } catch (error) {
    if (error instanceof LedgerWorkbookError) {
      res.status(400).json({ error: error.message, details: error.details });
      return;
    }
    next(error);
  }
});

app.get("/api/ledger/accounts", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const result = await withTenantTransaction(auth.tenantId, async (tx) => {
      const accounts = await tx.query(
        "SELECT account_code, account_name FROM ledger_accounts ORDER BY account_code LIMIT 2000"
      );
      const mappings = await tx.query(
        "SELECT mapping_key, account_code FROM tenant_account_mappings"
      );
      return {
        accounts: accounts.rows,
        mappings: Object.fromEntries(mappings.rows.map((row) => [row.mapping_key, row.account_code]))
      };
    }, auth.userId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.put("/api/ledger/mappings", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const input = ledgerMappingSchema.parse(req.body);
    const mappings = [
      ["expense", input.expenseAccountCode],
      ["input_tax", input.inputTaxAccountCode],
      ["accounts_payable", input.payableAccountCode]
    ] as const;
    await withTenantTransaction(auth.tenantId, async (tx) => {
      const accountCodes = mappings.map(([, code]) => code);
      const found = await tx.query<{ account_code: string }>(
        "SELECT account_code FROM ledger_accounts WHERE account_code = ANY($1::text[])",
        [accountCodes]
      );
      const foundCodes = new Set(found.rows.map((row) => row.account_code));
      const missing = [...new Set(accountCodes)].filter((code) => !foundCodes.has(code));
      if (missing.length) throw new HttpError(400, `Không tìm thấy mã tài khoản: ${missing.join(", ")}`);
      for (const [mappingKey, accountCode] of mappings) {
        await tx.query(
          `INSERT INTO tenant_account_mappings (tenant_id, mapping_key, account_code)
           VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, mapping_key)
           DO UPDATE SET account_code = EXCLUDED.account_code, updated_at = now()`,
          [auth.tenantId, mappingKey, accountCode]
        );
      }
      await tx.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, details)
         VALUES ($1, $2, 'ledger.account_mappings_updated', 'tenant_account_mappings', $3)`,
        [auth.tenantId, auth.userId, JSON.stringify(Object.fromEntries(mappings))]
      );
    }, auth.userId);
    res.json({ status: "saved" });
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "Cấu hình tài khoản đã thay đổi đồng thời; hãy tải lại và thử lại." });
      return;
    }
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
    const options = parseListOptions(req, true);
    const result = await withTenantTransaction(auth.tenantId, async (tx) => {
      const count = await tx.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM suppliers
         WHERE ($1 = 'all' OR status = $1)
           AND ($2 = '' OR position(lower($2) in lower(code)) > 0
             OR position(lower($2) in lower(name)) > 0
             OR position(lower($2) in lower(COALESCE(tax_id, ''))) > 0)`,
        [options.status, options.search]
      );
      const suppliers = await tx.query(
        `SELECT id, code, name, tax_id, email, phone, address, status
         FROM suppliers
         WHERE ($1 = 'all' OR status = $1)
           AND ($2 = '' OR position(lower($2) in lower(code)) > 0
             OR position(lower($2) in lower(name)) > 0
             OR position(lower($2) in lower(COALESCE(tax_id, ''))) > 0)
         ORDER BY name, code LIMIT $3 OFFSET $4`,
        [options.status, options.search, options.pageSize, options.offset]
      );
      return { suppliers: suppliers.rows, total: Number(count.rows[0]?.total ?? 0) };
    }, auth.userId);
    res.json({ ...result, page: options.page, pageSize: options.pageSize });
  } catch (error) {
    next(error);
  }
});

app.post("/api/suppliers", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const input = supplierSchema.parse(req.body);
    const supplier = await withTenantTransaction(auth.tenantId, async (tx) => {
      const result = await tx.query(
        `INSERT INTO suppliers (tenant_id, code, name, tax_id, email, phone, address)
         VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7)
         RETURNING id, code, name, tax_id, email, phone, address, status`,
        [
          auth.tenantId, input.code, input.name, input.taxId ?? null,
          input.email ?? "", input.phone ?? null, input.address ?? null
        ]
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

app.put("/api/suppliers/:supplierId", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const supplierId = uuidParam(req.params.supplierId);
    const input = supplierSchema.parse(req.body);
    const supplier = await withTenantTransaction(auth.tenantId, async (tx) => {
      const result = await tx.query(
        `UPDATE suppliers SET code = $3, name = $4, tax_id = $5, email = NULLIF($6, ''),
           phone = $7, address = $8, updated_at = now()
         WHERE tenant_id = $1 AND id = $2
         RETURNING id, code, name, tax_id, email, phone, address, status`,
        [
          auth.tenantId, supplierId, input.code, input.name, input.taxId ?? null,
          input.email ?? "", input.phone ?? null, input.address ?? null
        ]
      );
      if (!result.rows[0]) throw new HttpError(404, "Không tìm thấy nhà cung cấp trong tenant hiện tại");
      await tx.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id)
         VALUES ($1, $2, 'supplier.updated', 'supplier', $3)`,
        [auth.tenantId, auth.userId, supplierId]
      );
      return result.rows[0];
    }, auth.userId);
    res.json(supplier);
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "Mã hoặc mã số thuế nhà cung cấp đã tồn tại" });
      return;
    }
    next(error);
  }
});

app.delete("/api/suppliers/:supplierId", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const supplierId = uuidParam(req.params.supplierId);
    await withTenantTransaction(auth.tenantId, async (tx) => {
      const result = await tx.query(
        `UPDATE suppliers SET status = 'archived', updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
        [auth.tenantId, supplierId]
      );
      if (!result.rowCount) throw new HttpError(404, "Không tìm thấy nhà cung cấp đang hoạt động");
      await tx.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id)
         VALUES ($1, $2, 'supplier.archived', 'supplier', $3)`,
        [auth.tenantId, auth.userId, supplierId]
      );
    }, auth.userId);
    res.json({ status: "archived" });
  } catch (error) {
    next(error);
  }
});

app.post("/api/suppliers/:supplierId/restore", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const supplierId = uuidParam(req.params.supplierId);
    await withTenantTransaction(auth.tenantId, async (tx) => {
      const result = await tx.query(
        `UPDATE suppliers SET status = 'active', updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND status = 'archived'`,
        [auth.tenantId, supplierId]
      );
      if (!result.rowCount) throw new HttpError(404, "Không tìm thấy nhà cung cấp đã lưu trữ");
      await tx.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id)
         VALUES ($1, $2, 'supplier.restored', 'supplier', $3)`,
        [auth.tenantId, auth.userId, supplierId]
      );
    }, auth.userId);
    res.json({ status: "active" });
  } catch (error) {
    next(error);
  }
});

app.get("/api/products", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const options = parseListOptions(req, true);
    const result = await withTenantTransaction(auth.tenantId, async (tx) => {
      const count = await tx.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM products
         WHERE ($1 = 'all' OR status = $1)
           AND ($2 = '' OR position(lower($2) in lower(code)) > 0
             OR position(lower($2) in lower(name)) > 0)`,
        [options.status, options.search]
      );
      const products = await tx.query(
        `SELECT id, code, name, unit, default_unit_price, currency, tax_rate, status
         FROM products
         WHERE ($1 = 'all' OR status = $1)
           AND ($2 = '' OR position(lower($2) in lower(code)) > 0
             OR position(lower($2) in lower(name)) > 0)
         ORDER BY name, code LIMIT $3 OFFSET $4`,
        [options.status, options.search, options.pageSize, options.offset]
      );
      return { products: products.rows, total: Number(count.rows[0]?.total ?? 0) };
    }, auth.userId);
    res.json({ ...result, page: options.page, pageSize: options.pageSize });
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

app.put("/api/products/:productId", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const productId = uuidParam(req.params.productId);
    const input = productSchema.parse(req.body);
    const product = await withTenantTransaction(auth.tenantId, async (tx) => {
      const result = await tx.query(
        `UPDATE products SET code = $3, name = $4, unit = $5, default_unit_price = $6,
           currency = $7, tax_rate = $8, updated_at = now()
         WHERE tenant_id = $1 AND id = $2
         RETURNING id, code, name, unit, default_unit_price, currency, tax_rate, status`,
        [
          auth.tenantId, productId, input.code, input.name, input.unit ?? null,
          input.defaultUnitPrice ?? null, input.currency, input.taxRate ?? null
        ]
      );
      if (!result.rows[0]) throw new HttpError(404, "Không tìm thấy hàng hóa trong tenant hiện tại");
      await tx.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id)
         VALUES ($1, $2, 'product.updated', 'product', $3)`,
        [auth.tenantId, auth.userId, productId]
      );
      return result.rows[0];
    }, auth.userId);
    res.json(product);
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "Mã hàng hóa đã tồn tại trong tenant này" });
      return;
    }
    next(error);
  }
});

app.delete("/api/products/:productId", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const productId = uuidParam(req.params.productId);
    await withTenantTransaction(auth.tenantId, async (tx) => {
      const result = await tx.query(
        `UPDATE products SET status = 'archived', updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
        [auth.tenantId, productId]
      );
      if (!result.rowCount) throw new HttpError(404, "Không tìm thấy hàng hóa đang hoạt động");
      await tx.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id)
         VALUES ($1, $2, 'product.archived', 'product', $3)`,
        [auth.tenantId, auth.userId, productId]
      );
    }, auth.userId);
    res.json({ status: "archived" });
  } catch (error) {
    next(error);
  }
});

app.post("/api/products/:productId/restore", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const productId = uuidParam(req.params.productId);
    await withTenantTransaction(auth.tenantId, async (tx) => {
      const result = await tx.query(
        `UPDATE products SET status = 'active', updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND status = 'archived'`,
        [auth.tenantId, productId]
      );
      if (!result.rowCount) throw new HttpError(404, "Không tìm thấy hàng hóa đã lưu trữ");
      await tx.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id)
         VALUES ($1, $2, 'product.restored', 'product', $3)`,
        [auth.tenantId, auth.userId, productId]
      );
    }, auth.userId);
    res.json({ status: "active" });
  } catch (error) {
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

function parseListOptions(
  req: Request,
  includeStatus = false
): { page: number; pageSize: number; offset: number; search: string; status: string } {
  const pageValue = req.query.page === undefined ? "1" : req.query.page;
  const searchValue = req.query.q === undefined ? "" : req.query.q;
  const statusValue = req.query.status === undefined ? "active" : req.query.status;
  if (
    typeof pageValue !== "string" || !/^[1-9]\d*$/.test(pageValue)
    || !Number.isSafeInteger(Number(pageValue)) || Number(pageValue) > 1_000_000
  ) {
    throw new HttpError(400, "Số trang không hợp lệ");
  }
  if (typeof searchValue !== "string" || searchValue.length > 100) {
    throw new HttpError(400, "Từ khóa tìm kiếm tối đa 100 ký tự");
  }
  if (includeStatus && (
    typeof statusValue !== "string" || !["active", "archived", "all"].includes(statusValue)
  )) {
    throw new HttpError(400, "Bộ lọc trạng thái không hợp lệ");
  }
  const page = Number(pageValue);
  const pageSize = 20;
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    search: searchValue.trim(),
    status: includeStatus ? String(statusValue) : "all"
  };
}

async function parseLedgerUpload(file: Express.Multer.File | undefined) {
  if (!file) throw new HttpError(400, "Vui lòng chọn file Excel sổ cái.");
  if (!/\.xlsx$/i.test(file.originalname)) {
    throw new HttpError(415, "Chỉ hỗ trợ file Excel .xlsx. Hãy lưu workbook dưới định dạng Excel Workbook.");
  }
  return parseLedgerWorkbook(file.buffer);
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
