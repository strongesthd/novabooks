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
import {
  createInventoryWorkbook, InventoryAssignmentInput, InventoryCatalogEntry, InventoryMovementInput as ParsedInventoryMovement,
  InventoryMovementType, InventoryWorkbookError, normalizeInventoryCode, parseInventoryWorkbook,
  ParsedInventoryWorkbook
} from "./inventory";
import {
  createInventoryAssignment, createInventoryMovement, currentInventoryQuantity,
  decimalToUnits, firstNegativeStockMovement, returnInventoryAssignment
} from "./inventory-service";
import { DocumentValidationError, loadDocument } from "./storage";
import { AuthenticatedRequest, AuthContext, TenantRole } from "./types";
import {
  channelSchema, inventoryAssignmentSchema, inventoryImportSchema, inventoryItemSchema,
  inventoryItemStatusSchema, inventoryMovementSchema, inviteSchema, ledgerMappingSchema, loginSchema, productSchema,
  registerSchema, reviewSchema, supplierSchema
} from "./validation";
import {
  createVoucherFromUpload, editVoucher, getVoucherDocument, listVouchers,
  retryVoucherExtraction, reviewVoucher
} from "./vouchers";
import { HttpError } from "./http-error";

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
      auth, uuidParam(req.params.voucherId), input.decision, input.note, input.accountMappings, input.inventoryLines
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
    const mappings: Array<[string, string]> = [
      ["expense", input.expenseAccountCode],
      ["input_tax", input.inputTaxAccountCode],
      ["accounts_payable", input.payableAccountCode]
    ];
    if (input.inventoryAccountCode) {
      mappings.push(["inventory_asset", input.inventoryAccountCode]);
    }
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
      if (!input.inventoryAccountCode) {
        await tx.query(
          "DELETE FROM tenant_account_mappings WHERE tenant_id = $1 AND mapping_key = 'inventory_asset'",
          [auth.tenantId]
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

app.get("/api/inventory/items/options", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const result = await withTenantTransaction(auth.tenantId, async (tx) => tx.query(
      `SELECT i.id, i.code, i.name, i.unit,
              (i.opening_quantity + COALESCE(sum(
                 CASE WHEN m.movement_type IN ('purchase_in', 'return_in', 'adjustment_in') THEN m.quantity
                      ELSE -m.quantity END
               ), 0))::text AS current_quantity
       FROM inventory_items i
       LEFT JOIN inventory_movements m
         ON m.tenant_id = i.tenant_id AND m.item_id = i.id
       WHERE i.status = 'active'
       GROUP BY i.tenant_id, i.id
       ORDER BY i.code
       LIMIT 2000`
    ), auth.userId);
    res.json({ items: result.rows });
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/items", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const options = parseListOptions(req, true);
    const result = await withTenantTransaction(auth.tenantId, async (tx) => {
      const filter = `($1 = 'all' OR i.status = $1)
        AND ($2 = '' OR i.code ILIKE '%' || $2 || '%' OR i.name ILIKE '%' || $2 || '%'
             OR COALESCE(i.category, '') ILIKE '%' || $2 || '%')`;
      const count = await tx.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM inventory_items i WHERE ${filter}`,
        [options.status, options.search]
      );
      const rows = await tx.query(
        `SELECT i.id, i.code, i.name, i.category, i.unit, i.minimum_quantity::text,
                i.location, i.notes, i.opening_quantity::text, i.opening_date::text, i.status,
                (i.opening_quantity + COALESCE(sum(
                   CASE WHEN m.movement_type IN ('purchase_in', 'return_in', 'adjustment_in') THEN m.quantity
                        ELSE -m.quantity END
                 ), 0))::text AS current_quantity,
                COALESCE(sum(CASE WHEN m.movement_type IN ('purchase_in', 'return_in', 'adjustment_in')
                                  THEN m.quantity ELSE 0 END), 0)::text AS total_incoming,
                COALESCE(sum(CASE WHEN m.movement_type IN ('production_out', 'issue_out', 'adjustment_out')
                                  THEN m.quantity ELSE 0 END), 0)::text AS total_outgoing
         FROM inventory_items i
         LEFT JOIN inventory_movements m ON m.tenant_id = i.tenant_id AND m.item_id = i.id
         WHERE ${filter}
         GROUP BY i.tenant_id, i.id
         ORDER BY i.code
         LIMIT $3 OFFSET $4`,
        [options.status, options.search, options.pageSize, options.offset]
      );
      return { items: rows.rows, total: Number(count.rows[0]?.total ?? 0) };
    }, auth.userId);
    res.json({ ...result, page: options.page, pageSize: options.pageSize });
  } catch (error) {
    next(error);
  }
});

app.post("/api/inventory/items", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const input = inventoryItemSchema.parse(req.body);
    const item = await withTenantTransaction(auth.tenantId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        `INSERT INTO inventory_items
           (tenant_id, code, name, category, unit, minimum_quantity, location, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          auth.tenantId, input.code, input.name, input.category ?? null, input.unit ?? null,
          input.minimumQuantity, input.location ?? null, input.notes ?? null
        ]
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error("Inventory item insert returned no identifier");
      await tx.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, $2, 'inventory.item_created', 'inventory_item', $3, $4)`,
        [auth.tenantId, auth.userId, id, JSON.stringify({ code: input.code })]
      );
      return { id };
    }, auth.userId);
    res.status(201).json(item);
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "Mã vật tư đã tồn tại trong doanh nghiệp." });
      return;
    }
    next(error);
  }
});

app.put("/api/inventory/items/:itemId", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const input = inventoryItemSchema.parse(req.body);
    const itemId = uuidParam(req.params.itemId);
    await withTenantTransaction(auth.tenantId, async (tx) => {
      const result = await tx.query(
        `UPDATE inventory_items
         SET code = $3, name = $4, category = $5, unit = $6, minimum_quantity = $7,
             location = $8, notes = $9, updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [
          auth.tenantId, itemId, input.code, input.name, input.category ?? null, input.unit ?? null,
          input.minimumQuantity, input.location ?? null, input.notes ?? null
        ]
      );
      if (!result.rowCount) throw new HttpError(404, "Không tìm thấy vật tư trong tenant hiện tại");
      await tx.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, $2, 'inventory.item_updated', 'inventory_item', $3, $4)`,
        [auth.tenantId, auth.userId, itemId, JSON.stringify({ code: input.code })]
      );
    }, auth.userId);
    res.json({ status: "updated" });
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "Mã vật tư đã tồn tại trong doanh nghiệp." });
      return;
    }
    next(error);
  }
});

app.patch("/api/inventory/items/:itemId/status", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const itemId = uuidParam(req.params.itemId);
    const { status } = inventoryItemStatusSchema.parse(req.body);
    await withTenantTransaction(auth.tenantId, async (tx) => {
      const item = await tx.query<{ id: string; status: string }>(
        "SELECT id, status FROM inventory_items WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [auth.tenantId, itemId]
      );
      if (!item.rows[0]) throw new HttpError(404, "Không tìm thấy vật tư trong tenant hiện tại");
      if (status === "archived") {
        const quantity = await currentInventoryQuantity(tx, auth.tenantId, itemId);
        if (decimalToUnits(quantity) !== 0n) {
          throw new HttpError(409, "Chỉ có thể lưu trữ vật tư khi tồn kho bằng 0");
        }
        const activeAssignments = await tx.query(
          "SELECT 1 FROM inventory_assignments WHERE tenant_id = $1 AND item_id = $2 AND status = 'active' LIMIT 1",
          [auth.tenantId, itemId]
        );
        if (activeAssignments.rowCount) {
          throw new HttpError(409, "Vật tư đang có phiếu cấp phát chưa thu hồi");
        }
      }
      await tx.query(
        "UPDATE inventory_items SET status = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2",
        [auth.tenantId, itemId, status]
      );
      await tx.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, $2, 'inventory.item_status_changed', 'inventory_item', $3, $4)`,
        [auth.tenantId, auth.userId, itemId, JSON.stringify({ status })]
      );
    }, auth.userId);
    res.json({ status });
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/movements", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const options = parseListOptions(req);
    const type = req.query.type === undefined ? "" : req.query.type;
    const types = ["purchase_in", "production_out", "issue_out", "return_in", "adjustment_in", "adjustment_out"];
    if (typeof type !== "string" || (type && !types.includes(type))) {
      throw new HttpError(400, "Loại giao dịch kho không hợp lệ");
    }
    const result = await withTenantTransaction(auth.tenantId, async (tx) => {
      const filter = `($1 = '' OR m.document_number ILIKE '%' || $1 || '%'
          OR i.code ILIKE '%' || $1 || '%' OR i.name ILIKE '%' || $1 || '%')
        AND ($2 = '' OR m.movement_type = $2)`;
      const count = await tx.query<{ total: string }>(
        `SELECT count(*)::text AS total
         FROM inventory_movements m JOIN inventory_items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id
         WHERE ${filter}`,
        [options.search, type]
      );
      const rows = await tx.query(
        `SELECT m.id, m.movement_date::text, m.document_number, m.movement_type,
                m.quantity::text, m.recipient, m.notes, i.code AS item_code, i.name AS item_name, i.unit
         FROM inventory_movements m
         JOIN inventory_items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id
         WHERE ${filter}
         ORDER BY m.movement_date DESC, m.created_at DESC
         LIMIT $3 OFFSET $4`,
        [options.search, type, options.pageSize, options.offset]
      );
      return { movements: rows.rows, total: Number(count.rows[0]?.total ?? 0) };
    }, auth.userId);
    res.json({ ...result, page: options.page, pageSize: options.pageSize });
  } catch (error) {
    next(error);
  }
});

app.post("/api/inventory/movements", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const input = inventoryMovementSchema.parse(req.body);
    assertDateOnly(input.date);
    await withTenantTransaction(auth.tenantId, async (tx) => {
      await createInventoryMovement(tx, auth, input);
    }, auth.userId);
    res.status(201).json({ status: "recorded" });
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/assignments", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const options = parseListOptions(req, true);
    const result = await withTenantTransaction(auth.tenantId, async (tx) => {
      const filter = `($1 = 'all' OR a.status = $1)
        AND ($2 = '' OR a.document_number ILIKE '%' || $2 || '%'
             OR a.recipient ILIKE '%' || $2 || '%' OR i.code ILIKE '%' || $2 || '%'
             OR i.name ILIKE '%' || $2 || '%')`;
      const count = await tx.query<{ total: string }>(
        `SELECT count(*)::text AS total
         FROM inventory_assignments a JOIN inventory_items i ON i.tenant_id = a.tenant_id AND i.id = a.item_id
         WHERE ${filter}`,
        [options.status, options.search]
      );
      const rows = await tx.query(
        `SELECT a.id, a.document_number, a.issued_at::text, a.recipient, a.team,
                a.quantity::text, a.condition, a.due_date::text, a.notes, a.status,
                a.returned_at, i.id AS item_id, i.code AS item_code, i.name AS item_name, i.unit
         FROM inventory_assignments a
         JOIN inventory_items i ON i.tenant_id = a.tenant_id AND i.id = a.item_id
         WHERE ${filter}
         ORDER BY a.issued_at DESC, a.created_at DESC
         LIMIT $3 OFFSET $4`,
        [options.status, options.search, options.pageSize, options.offset]
      );
      return { assignments: rows.rows, total: Number(count.rows[0]?.total ?? 0) };
    }, auth.userId);
    res.json({ ...result, page: options.page, pageSize: options.pageSize });
  } catch (error) {
    next(error);
  }
});

app.post("/api/inventory/assignments", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const input = inventoryAssignmentSchema.parse(req.body);
    assertDateOnly(input.issuedAt);
    if (input.dueDate) assertDateOnly(input.dueDate);
    const assignmentId = await withTenantTransaction(
      auth.tenantId,
      (tx) => createInventoryAssignment(tx, auth, input),
      auth.userId
    );
    res.status(201).json({ id: assignmentId, status: "active" });
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "Phiếu cấp phát đã tồn tại." });
      return;
    }
    next(error);
  }
});

app.post("/api/inventory/assignments/:assignmentId/return", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    await withTenantTransaction(
      auth.tenantId,
      (tx) => returnInventoryAssignment(tx, auth, uuidParam(req.params.assignmentId)),
      auth.userId
    );
    res.json({ status: "returned" });
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/template", authenticate, requireRoles("tenant_admin", "accountant"), async (_req, res, next) => {
  try {
    const buffer = await createInventoryWorkbook({ items: [], movements: [], assignments: [] });
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .set("Content-Disposition", 'attachment; filename="novabooks-inventory-template.xlsx"')
      .send(buffer);
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/export", authenticate, requireRoles("tenant_admin", "accountant"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const data = await withTenantTransaction(auth.tenantId, async (tx) => {
      const itemCount = await tx.query<{ total: string }>("SELECT count(*)::text AS total FROM inventory_items");
      const movementCount = await tx.query<{ total: string }>("SELECT count(*)::text AS total FROM inventory_movements");
      const assignmentCount = await tx.query<{ total: string }>("SELECT count(*)::text AS total FROM inventory_assignments");
      if (Number(itemCount.rows[0]?.total) > 10_000 || Number(movementCount.rows[0]?.total) > 20_000
          || Number(assignmentCount.rows[0]?.total) > 10_000) {
        throw new HttpError(413, "Dữ liệu kho vượt giới hạn xuất Excel; hãy thu hẹp phạm vi dữ liệu trước.");
      }
      const items = await tx.query(
        `SELECT i.code, i.name, i.category, i.unit, i.minimum_quantity::text,
                i.location, i.notes, i.opening_quantity::text,
                (i.opening_quantity + COALESCE(sum(
                   CASE WHEN m.movement_type IN ('purchase_in', 'return_in', 'adjustment_in') THEN m.quantity
                        ELSE -m.quantity END
                 ), 0))::text AS current_quantity,
                COALESCE(sum(CASE WHEN m.movement_type IN ('purchase_in', 'return_in', 'adjustment_in')
                                  THEN m.quantity ELSE 0 END), 0)::text AS total_incoming,
                COALESCE(sum(CASE WHEN m.movement_type IN ('production_out', 'issue_out', 'adjustment_out')
                                  THEN m.quantity ELSE 0 END), 0)::text AS total_outgoing,
                i.status,
                CASE WHEN (i.opening_quantity + COALESCE(sum(
                   CASE WHEN m.movement_type IN ('purchase_in', 'return_in', 'adjustment_in') THEN m.quantity
                        ELSE -m.quantity END
                 ), 0)) <= i.minimum_quantity THEN 'Cần nhập' ELSE 'Đủ tồn' END AS stock_status
         FROM inventory_items i
         LEFT JOIN inventory_movements m ON m.tenant_id = i.tenant_id AND m.item_id = i.id
         GROUP BY i.tenant_id, i.id ORDER BY i.code`
      );
      const movements = await tx.query(
        `SELECT m.movement_date::text AS date, m.document_number, m.movement_type AS type,
                i.code AS item_code, i.name AS item_name, i.unit, m.quantity::text,
                m.recipient, m.notes
         FROM inventory_movements m
         JOIN inventory_items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id
         ORDER BY m.movement_date, m.created_at`
      );
      const assignments = await tx.query(
        `SELECT a.document_number, a.issued_at::text, a.recipient, a.team, i.code AS item_code,
                a.quantity::text, a.condition, a.due_date::text, a.notes, a.status
         FROM inventory_assignments a
         JOIN inventory_items i ON i.tenant_id = a.tenant_id AND i.id = a.item_id
         ORDER BY a.issued_at, a.created_at`
      );
      return { items: items.rows, movements: movements.rows, assignments: assignments.rows };
    }, auth.userId);
    const buffer = await createInventoryWorkbook({
      items: data.items.map((row) => ({
        code: row.code, name: row.name, category: row.category, unit: row.unit,
        minimumQuantity: row.minimum_quantity, location: row.location, notes: row.notes,
        openingQuantity: row.opening_quantity, currentQuantity: row.current_quantity,
        totalIncoming: row.total_incoming, totalOutgoing: row.total_outgoing, status: row.stock_status
      })),
      movements: data.movements.map((row) => ({
        date: row.date, documentNumber: row.document_number, type: row.type, itemCode: row.item_code,
        itemName: row.item_name, unit: row.unit, quantity: row.quantity, recipient: row.recipient,
        notes: row.notes, rowNumber: 0
      })),
      assignments: data.assignments.map((row) => ({
        documentNumber: row.document_number, issuedAt: row.issued_at, recipient: row.recipient,
        team: row.team, itemCode: row.item_code, quantity: row.quantity, condition: row.condition,
        dueDate: row.due_date, notes: row.notes, status: row.status, rowNumber: 0
      }))
    });
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .set("Content-Disposition", 'attachment; filename="novabooks-inventory.xlsx"')
      .send(buffer);
  } catch (error) {
    next(error);
  }
});

app.post("/api/inventory/import/preview", authenticate, requireRoles("tenant_admin", "accountant"), upload.single("inventory"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const file = parseInventoryUpload(req.file);
    const { openingDate } = inventoryImportSchema.parse(req.body);
    assertDateOnly(openingDate);
    const parsed = await parseInventoryWorkbook(file.buffer);
    const fileHash = createHash("sha256").update(file.buffer).digest();
    const plan = await withTenantTransaction(
      auth.tenantId,
      (tx) => prepareInventoryImport(tx, auth.tenantId, parsed, openingDate, fileHash),
      auth.userId
    );
    res.json({
      canImport: !plan.errors.length && !plan.duplicateBatch,
      duplicateBatch: plan.duplicateBatch,
      itemCount: plan.newItems.length,
      movementCount: plan.movements.length,
      assignmentCount: plan.assignments.length,
      skippedMovementCount: plan.skippedMovementCount,
      skippedAssignmentCount: plan.skippedAssignmentCount,
      warnings: plan.warnings,
      errors: plan.errors
    });
  } catch (error) {
    if (error instanceof InventoryWorkbookError) {
      res.status(400).json({ error: error.message, details: error.details });
      return;
    }
    next(error);
  }
});

app.post("/api/inventory/import", authenticate, requireRoles("tenant_admin", "accountant"), upload.single("inventory"), async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const file = parseInventoryUpload(req.file);
    const { openingDate } = inventoryImportSchema.parse(req.body);
    assertDateOnly(openingDate);
    const parsed = await parseInventoryWorkbook(file.buffer);
    const fileHash = createHash("sha256").update(file.buffer).digest();
    const result = await withTenantTransaction(auth.tenantId, async (tx) => {
      const plan = await prepareInventoryImport(tx, auth.tenantId, parsed, openingDate, fileHash);
      if (plan.duplicateBatch) throw new HttpError(409, "Workbook này đã được nhập trước đó.");
      if (plan.errors.length) throw new HttpError(422, plan.errors.slice(0, 10).join(" "));
      const batch = await tx.query<{ id: string }>(
        `INSERT INTO inventory_import_batches
           (tenant_id, file_sha256, file_name, opening_date, item_count, movement_count,
            assignment_count, imported_by_membership_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          auth.tenantId, fileHash, file.originalname.slice(0, 255), openingDate,
          plan.newItems.length, plan.movements.length, plan.assignments.length, auth.membershipId
        ]
      );
      const batchId = batch.rows[0]?.id;
      if (!batchId) throw new Error("Inventory import batch insert returned no identifier");

      for (const item of plan.newItems) {
        await tx.query(
          `INSERT INTO inventory_items
             (tenant_id, code, name, category, unit, minimum_quantity, location, notes,
              opening_quantity, opening_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            auth.tenantId, item.code, item.name, item.category, item.unit, item.minimumQuantity,
            item.location, item.notes, item.openingQuantity, openingDate
          ]
        );
      }
      const allItems = await tx.query<{ id: string; code: string }>(
        "SELECT id, code FROM inventory_items WHERE tenant_id = $1 AND lower(code) = ANY($2::text[])",
        [auth.tenantId, parsed.items.map((item) => normalizeInventoryCode(item.code))]
      );
      const itemIds = new Map(allItems.rows.map((item) => [normalizeInventoryCode(item.code), item.id]));
      const assignmentIds = new Map<number, string>();
      for (const assignment of plan.assignments) {
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO inventory_assignments
             (tenant_id, item_id, document_number, issued_at, recipient, team, quantity,
              condition, due_date, notes, status, source_kind, source_key, source_batch_id,
              created_by_membership_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'workbook', $12, $13, $14)
           RETURNING id`,
          [
            auth.tenantId, itemIds.get(normalizeInventoryCode(assignment.itemCode)),
            assignment.documentNumber, assignment.issuedAt, assignment.recipient, assignment.team,
            assignment.quantity, assignment.condition, assignment.dueDate, assignment.notes,
            assignment.status, `workbook:${fileHash.toString("hex")}:assignment:${assignment.rowNumber}`,
            batchId, auth.membershipId
          ]
        );
        const assignmentId = inserted.rows[0]?.id;
        if (!assignmentId) throw new Error("Inventory assignment insert returned no identifier");
        assignmentIds.set(assignment.rowNumber, assignmentId);
      }
      for (const movement of plan.movements) {
        const assignmentId = movement.assignmentRow === undefined
          ? null
          : assignmentIds.get(movement.assignmentRow) ?? null;
        await tx.query(
          `INSERT INTO inventory_movements
             (tenant_id, item_id, movement_date, document_number, movement_type, quantity,
              recipient, notes, source_kind, source_key, source_batch_id, source_assignment_id,
              created_by_membership_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            auth.tenantId, itemIds.get(normalizeInventoryCode(movement.itemCode)), movement.date,
            movement.documentNumber, movement.type, movement.quantity, movement.recipient,
            movement.notes, assignmentId ? "assignment" : "workbook",
            `workbook:${fileHash.toString("hex")}:${movement.assignmentRow === undefined ? "journal" : "assignment"}:${movement.rowNumber}`,
            batchId, assignmentId, auth.membershipId
          ]
        );
      }
      await tx.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, $2, 'inventory.workbook_imported', 'inventory_import_batch', $3, $4)`,
        [auth.tenantId, auth.userId, batchId, JSON.stringify({
          items: plan.newItems.length,
          movements: plan.movements.length,
          assignments: plan.assignments.length,
          skippedMovements: plan.skippedMovementCount,
          skippedAssignments: plan.skippedAssignmentCount
        })]
      );
      return {
        batchId,
        itemCount: plan.newItems.length,
        movementCount: plan.movements.length,
        assignmentCount: plan.assignments.length,
        skippedMovementCount: plan.skippedMovementCount,
        skippedAssignmentCount: plan.skippedAssignmentCount
      };
    }, auth.userId);
    res.status(201).json({ status: "imported", ...result });
  } catch (error) {
    if (error instanceof InventoryWorkbookError) {
      res.status(400).json({ error: error.message, details: error.details });
      return;
    }
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "Workbook hoặc mã vật tư đã được nhập đồng thời; hãy tải lại dữ liệu." });
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

function parseInventoryUpload(file: Express.Multer.File | undefined): Express.Multer.File {
  if (!file) throw new HttpError(400, "Vui lòng chọn workbook quản lý kho.");
  if (!/\.xlsx$/i.test(file.originalname)) {
    throw new HttpError(415, "Chỉ hỗ trợ workbook Excel .xlsx.");
  }
  return file;
}

type PlannedInventoryMovement = {
  date: string;
  documentNumber: string;
  type: InventoryMovementType;
  itemCode: string;
  quantity: string;
  recipient: string | null;
  notes: string | null;
  rowNumber: number;
  assignmentRow?: number;
};

type InventoryImportPlan = {
  duplicateBatch: boolean;
  newItems: InventoryCatalogEntry[];
  movements: PlannedInventoryMovement[];
  assignments: InventoryAssignmentInput[];
  skippedMovementCount: number;
  skippedAssignmentCount: number;
  warnings: string[];
  errors: string[];
};

async function prepareInventoryImport(
  tx: import("./db").TenantTransaction,
  tenantId: string,
  workbook: ParsedInventoryWorkbook,
  openingDate: string,
  fileHash: Buffer
): Promise<InventoryImportPlan> {
  const batchResult = await tx.query(
    "SELECT 1 FROM inventory_import_batches WHERE tenant_id = $1 AND file_sha256 = $2",
    [tenantId, fileHash]
  );
  if (batchResult.rowCount) {
    return {
      duplicateBatch: true, newItems: [], movements: [], assignments: [],
      skippedMovementCount: 0, skippedAssignmentCount: 0, warnings: [], errors: []
    };
  }

  const itemCodes = workbook.items.map((item) => normalizeInventoryCode(item.code));
  await tx.query(
    `SELECT id FROM inventory_items
     WHERE tenant_id = $1 AND lower(code) = ANY($2::text[])
     ORDER BY id FOR UPDATE`,
    [tenantId, itemCodes]
  );
  const itemRows = await tx.query<{
    id: string;
    code: string;
    opening_quantity: string;
    opening_date: string;
    current_quantity: string;
    latest_movement_date: string | null;
    status: string;
  }>(
    `SELECT i.id, i.code, i.opening_quantity::text, i.opening_date::text, i.status,
            (i.opening_quantity + COALESCE(sum(
               CASE WHEN m.movement_type IN ('purchase_in', 'return_in', 'adjustment_in') THEN m.quantity
                    ELSE -m.quantity END
             ), 0))::text AS current_quantity,
            max(m.movement_date)::text AS latest_movement_date
     FROM inventory_items i
     LEFT JOIN inventory_movements m ON m.tenant_id = i.tenant_id AND m.item_id = i.id
     WHERE i.tenant_id = $1 AND lower(i.code) = ANY($2::text[])
     GROUP BY i.tenant_id, i.id`,
    [tenantId, itemCodes]
  );
  const existingByCode = new Map(itemRows.rows.map((row) => [normalizeInventoryCode(row.code), row]));
  const newItems = workbook.items.filter((item) => !existingByCode.has(normalizeInventoryCode(item.code)));
  const warnings: string[] = [];
  const errors: string[] = [];
  if (workbook.items.length !== newItems.length) {
    warnings.push(`${workbook.items.length - newItems.length} mã vật tư đã tồn tại; hệ thống giữ nguyên thông tin danh mục và số dư hiện có.`);
  }

  for (const movement of workbook.movements) {
    const existing = existingByCode.get(normalizeInventoryCode(movement.itemCode));
    if (existing?.status !== undefined && existing.status !== "active") {
      errors.push(`Vật tư ${movement.itemCode} đã lưu trữ nhưng workbook còn giao dịch mới.`);
    }
  }
  for (const assignment of workbook.assignments) {
    const existing = existingByCode.get(normalizeInventoryCode(assignment.itemCode));
    const startDate = existing?.opening_date ?? openingDate;
    if (assignment.status === "active" && assignment.issuedAt >= startDate
        && existing?.status !== undefined && existing.status !== "active") {
      errors.push(`Vật tư ${assignment.itemCode} đã lưu trữ nhưng workbook còn cấp phát mới.`);
    }
    if (assignment.status === "returned" && assignment.issuedAt >= startDate) {
      warnings.push(`Phiếu ${assignment.documentNumber} đã thu hồi nhưng sheet không có ngày thu hồi; hãy xác nhận Sổ Nhật Ký XNT có giao dịch thu hồi tương ứng.`);
    }
  }

  const existingItemIds = itemRows.rows.map((row) => row.id);
  const documentNumbers = [
    ...workbook.movements.map((item) => item.documentNumber),
    ...workbook.assignments.map((item) => item.documentNumber)
  ].map((value) => value.trim().toLocaleLowerCase("vi-VN"));
  const priorMovements = existingItemIds.length && documentNumbers.length
    ? await tx.query<{
        item_id: string;
        movement_date: string;
        document_number: string;
        movement_type: InventoryMovementType;
        quantity: string;
      }>(
        `SELECT item_id, movement_date::text, document_number, movement_type, quantity::text
         FROM inventory_movements
         WHERE tenant_id = $3 AND item_id = ANY($1::uuid[]) AND lower(document_number) = ANY($2::text[])`,
        [existingItemIds, documentNumbers, tenantId]
      )
    : { rows: [] as Array<{
        item_id: string; movement_date: string; document_number: string;
        movement_type: InventoryMovementType; quantity: string;
      }> };
  const existingMovementKeys = new Set(priorMovements.rows.map((row) =>
    movementIdentity(row.item_id, row.movement_date, row.document_number, row.movement_type, row.quantity)
  ));
  const plannedMovements: PlannedInventoryMovement[] = [];
  const pendingMovementKeys = new Set<string>();
  let skippedMovementCount = 0;
  const addMovement = (
    movement: PlannedInventoryMovement,
    itemId: string | undefined
  ): void => {
    if (!itemId) {
      errors.push(`Không tìm thấy mã vật tư ${movement.itemCode} khi chuẩn bị nhập workbook.`);
      return;
    }
    const key = movementIdentity(itemId, movement.date, movement.documentNumber, movement.type, movement.quantity);
    if (existingMovementKeys.has(key) || pendingMovementKeys.has(key)) {
      skippedMovementCount += 1;
      return;
    }
    const existing = existingByCode.get(normalizeInventoryCode(movement.itemCode));
    const openingBalanceDate = existing?.opening_date ?? openingDate;
    if (movement.date < openingBalanceDate) {
      errors.push(`Phiếu ${movement.documentNumber}: ngày giao dịch ${movement.date} trước ngày tồn đầu kỳ ${openingBalanceDate} của ${movement.itemCode}.`);
      return;
    }
    if (existing?.latest_movement_date && movement.date <= existing.latest_movement_date) {
      errors.push(`Phiếu ${movement.documentNumber}: ngày ${movement.date} không sau giao dịch kho hiện có cuối cùng (${existing.latest_movement_date}) của ${movement.itemCode}.`);
      return;
    }
    pendingMovementKeys.add(key);
    plannedMovements.push(movement);
  };
  const itemIdByCode = new Map(itemRows.rows.map((row) => [normalizeInventoryCode(row.code), row.id]));
  for (const item of newItems) {
    itemIdByCode.set(normalizeInventoryCode(item.code), `new:${normalizeInventoryCode(item.code)}`);
  }
  for (const movement of workbook.movements) {
    addMovement({
      date: movement.date,
      documentNumber: movement.documentNumber,
      type: movement.type,
      itemCode: movement.itemCode,
      quantity: movement.quantity,
      recipient: movement.recipient,
      notes: movement.notes,
      rowNumber: movement.rowNumber
    }, itemIdByCode.get(normalizeInventoryCode(movement.itemCode)));
  }

  const priorAssignments = existingItemIds.length && documentNumbers.length
    ? await tx.query<{
        item_id: string;
        document_number: string;
        issued_at: string;
        recipient: string;
        quantity: string;
      }>(
        `SELECT item_id, document_number, issued_at::text, recipient, quantity::text
         FROM inventory_assignments
         WHERE tenant_id = $3 AND item_id = ANY($1::uuid[]) AND lower(document_number) = ANY($2::text[])`,
        [existingItemIds, documentNumbers, tenantId]
      )
    : { rows: [] as Array<{
        item_id: string; document_number: string; issued_at: string; recipient: string; quantity: string;
      }> };
  const assignmentIdentity = (
    itemId: string, date: string, document: string, recipient: string, quantity: string
  ) => [itemId, date, document.trim().toLocaleLowerCase("vi-VN"),
    recipient.trim().toLocaleLowerCase("vi-VN"), decimalToUnits(quantity).toString()].join("|");
  const priorAssignmentKeys = new Set(priorAssignments.rows.map((row) =>
    assignmentIdentity(row.item_id, row.issued_at, row.document_number, row.recipient, row.quantity)
  ));
  const plannedAssignments: InventoryAssignmentInput[] = [];
  const inFileAssignmentKeys = new Set<string>();
  let skippedAssignmentCount = 0;
  for (const assignment of workbook.assignments) {
    const itemId = itemIdByCode.get(normalizeInventoryCode(assignment.itemCode));
    if (!itemId) {
      errors.push(`Không tìm thấy vật tư ${assignment.itemCode} cho phiếu cấp phát ${assignment.documentNumber}.`);
      continue;
    }
    const key = assignmentIdentity(itemId, assignment.issuedAt, assignment.documentNumber, assignment.recipient, assignment.quantity);
    if (priorAssignmentKeys.has(key) || inFileAssignmentKeys.has(key)) {
      skippedAssignmentCount += 1;
      continue;
    }
    inFileAssignmentKeys.add(key);
    plannedAssignments.push(assignment);
    if (assignment.status !== "active") continue;
    const startDate = existingByCode.get(normalizeInventoryCode(assignment.itemCode))?.opening_date ?? openingDate;
    if (assignment.issuedAt < startDate) continue;
    const issueIdentity = movementIdentity(itemId, assignment.issuedAt, assignment.documentNumber, "issue_out", assignment.quantity);
    if (existingMovementKeys.has(issueIdentity) || pendingMovementKeys.has(issueIdentity)) continue;
    addMovement({
      date: assignment.issuedAt,
      documentNumber: assignment.documentNumber,
      type: "issue_out",
      itemCode: assignment.itemCode,
      quantity: assignment.quantity,
      recipient: assignment.recipient,
      notes: assignment.notes ?? assignment.condition,
      rowNumber: assignment.rowNumber,
      assignmentRow: assignment.rowNumber
    }, itemId);
  }

  const openingByItem = new Map<string, bigint>();
  for (const item of workbook.items) {
    const existing = existingByCode.get(normalizeInventoryCode(item.code));
    openingByItem.set(
      normalizeInventoryCode(item.code),
      decimalToUnits(existing?.current_quantity ?? item.openingQuantity)
    );
  }
  const movementsByItem = new Map<string, PlannedInventoryMovement[]>();
  for (const movement of plannedMovements) {
    const key = normalizeInventoryCode(movement.itemCode);
    const rows = movementsByItem.get(key) ?? [];
    rows.push(movement);
    movementsByItem.set(key, rows);
  }
  for (const [itemCode, movements] of movementsByItem) {
    movements.sort((left, right) => left.date.localeCompare(right.date) || left.rowNumber - right.rowNumber);
    const index = firstNegativeStockMovement(unitsAsDecimal(openingByItem.get(itemCode) ?? 0n), movements);
    if (index !== null) {
      const movement = movements[index]!;
      errors.push(`Phiếu ${movement.documentNumber}: tồn ${movement.itemCode} bị âm tại ${movement.date}; kiểm tra tồn đầu kỳ và nhật ký.`);
    }
  }
  if (skippedMovementCount) warnings.push(`${skippedMovementCount} giao dịch đã tồn tại được bỏ qua để tránh cộng tồn hai lần.`);
  if (skippedAssignmentCount) warnings.push(`${skippedAssignmentCount} phiếu cấp phát đã tồn tại được bỏ qua.`);
  return {
    duplicateBatch: false,
    newItems,
    movements: plannedMovements,
    assignments: plannedAssignments,
    skippedMovementCount,
    skippedAssignmentCount,
    warnings,
    errors
  };
}

function movementIdentity(
  itemId: string,
  date: string,
  document: string,
  type: InventoryMovementType,
  quantity: string
): string {
  return [
    itemId,
    date,
    document.trim().toLocaleLowerCase("vi-VN"),
    type,
    decimalToUnits(quantity).toString()
  ].join("|");
}

function unitsAsDecimal(value: bigint): string {
  const whole = value / 10_000n;
  const fraction = (value % 10_000n).toString().padStart(4, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function assertDateOnly(value: string): void {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, "Ngày không hợp lệ");
  }
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
