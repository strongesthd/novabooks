import { randomUUID } from "node:crypto";
import { AuthContext } from "./types";
import { ExtractedInvoice, extractInvoice } from "./gemini";
import { TenantTransaction, withTenantTransaction } from "./db";
import { loadDocument, saveDocument } from "./storage";
import { sendText, getChannel } from "./channels";
import { decryptJson } from "./crypto";
import { config } from "./config";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { voucherEditSchema } from "./validation";

export async function createVoucherFromUpload(
  auth: AuthContext,
  file: { buffer: Buffer; mimeType: string; size: number },
  source?: { channelId: string; eventId: string }
): Promise<{ id: string }> {
  const saved = await saveDocument(auth.tenantId, file.buffer, file.mimeType);
  try {
    const result = await withTenantTransaction(auth.tenantId, async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO temp_vouchers
          (tenant_id, source_channel_id, source_event_id, submitted_by_membership_id,
           document_type, status, storage_key, file_sha256, mime_type, file_size_bytes)
         VALUES ($1, $2, $3, $4, 'purchase_invoice', 'received', $5, $6, $7, $8)
         RETURNING id`,
        [
          auth.tenantId, source?.channelId ?? null, source?.eventId ?? null,
          source ? null : auth.membershipId, saved.storageKey, saved.sha256, file.mimeType, file.size
        ]
      );
      const voucherId = inserted.rows[0]?.id;
      if (!voucherId) throw new Error("Voucher insert returned no identifier");
      await tx.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, request_id)
         VALUES ($1, $2, 'voucher.received', 'temp_voucher', $3, $4)`,
        [auth.tenantId, source ? null : auth.userId, voucherId, randomUUID()]
      );
      return { id: voucherId };
    }, source ? undefined : auth.userId);
    scheduleExtraction(auth.tenantId, result.id);
    return result;
  } catch (error) {
    await unlink(path.resolve(config.UPLOAD_DIR, saved.storageKey)).catch((cleanupError: unknown) => {
      console.error("orphaned document cleanup failed", {
        tenantId: auth.tenantId,
        error: cleanupError instanceof Error ? cleanupError.message : "unknown error"
      });
    });
    throw error;
  }
}

export async function retryVoucherExtraction(auth: AuthContext, voucherId: string): Promise<void> {
  const updated = await withTenantTransaction(auth.tenantId, async (tx) => {
    const result = await tx.query(
      `UPDATE temp_vouchers SET status = 'received', review_note = NULL, updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status = 'failed'`,
      [auth.tenantId, voucherId]
    );
    if (!result.rowCount) throw new HttpError(409, "Chỉ có thể thử lại chứng từ đang ở trạng thái lỗi");
    await tx.query(
      `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id)
       VALUES ($1, $2, 'voucher.extraction_retried', 'temp_voucher', $3)`,
      [auth.tenantId, auth.userId, voucherId]
    );
  }, auth.userId);
  scheduleExtraction(auth.tenantId, voucherId);
  return updated;
}

function scheduleExtraction(tenantId: string, voucherId: string): void {
  setImmediate(() => {
    void extractAndNotify(tenantId, voucherId).catch((error: unknown) => {
      console.error("voucher extraction worker failed", {
        tenantId,
        voucherId,
        error: error instanceof Error ? error.message : "unknown error"
      });
    });
  });
}

async function extractAndNotify(tenantId: string, voucherId: string): Promise<void> {
  const voucher = await withTenantTransaction(tenantId, async (tx) => {
    const result = await tx.query<{ storage_key: string; mime_type: string; source_channel_id: string | null }>(
      `UPDATE temp_vouchers SET status = 'extracting', updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status = 'received'
       RETURNING storage_key, mime_type, source_channel_id`,
      [tenantId, voucherId]
    );
    return result.rows[0] ?? null;
  });
  if (!voucher) return;

  try {
    const file = await loadDocument(voucher.storage_key);
    const extracted = await extractInvoice(file, voucher.mime_type);
    await withTenantTransaction(tenantId, async (tx) => {
      await persistExtraction(tx, tenantId, voucherId, extracted);
    });
  } catch (error) {
    await withTenantTransaction(tenantId, async (tx) => {
      await tx.query(
        `UPDATE temp_vouchers SET status = 'failed', review_note = $3, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND status = 'extracting'`,
        [tenantId, voucherId, "AI chưa thể trích xuất chứng từ. Kiểm tra cấu hình và thử lại."]
      );
      await tx.query(
        `INSERT INTO audit_logs (tenant_id, action, resource_type, resource_id, details)
         VALUES ($1, 'voucher.extraction_failed', 'temp_voucher', $2, $3)`,
        [tenantId, voucherId, JSON.stringify({ reason: "extraction_failed" })]
      );
    });
    throw error;
  }

  if (voucher.source_channel_id) {
    await withTenantTransaction(tenantId, async (tx) => {
      const channel = await getChannel(tenantId, voucher.source_channel_id!, tx);
      if (!channel) return;
      const secrets = decryptJson(channel.credentials_ciphertext);
      await sendText(
        channel,
        secrets,
        `NovaBooks: Chứng từ ${voucherId} đã được trích xuất. Vui lòng đăng nhập dashboard để kiểm tra và duyệt.`
      );
    });
  }
}

async function persistExtraction(
  tx: TenantTransaction,
  tenantId: string,
  voucherId: string,
  data: ExtractedInvoice
): Promise<void> {
  const invoiceDate = data.invoiceDate && /^\d{4}-\d{2}-\d{2}$/.test(data.invoiceDate)
    ? isValidDate(data.invoiceDate) ? data.invoiceDate : null
    : null;
  await tx.query(
    `UPDATE temp_vouchers
     SET status = 'needs_review', invoice_number = $3, invoice_date = $4,
         currency = $5, subtotal = $6, tax_amount = $7, total_amount = $8,
         extracted_data = $9, extraction_schema_version = 'invoice-v1',
         ai_provider = 'google-gemini', ai_model = $10, ai_confidence = $11,
         review_note = NULL, updated_at = now()
     WHERE tenant_id = $1 AND id = $2 AND status = 'extracting'`,
    [
      tenantId, voucherId, data.invoiceNumber, invoiceDate, data.currency,
      data.subtotal, data.taxAmount, data.totalAmount, JSON.stringify(data), config.GEMINI_MODEL,
      data.confidence
    ]
  );
}

export async function listVouchers(
  tx: TenantTransaction,
  role: AuthContext["role"],
  membershipId: string
): Promise<Array<Record<string, unknown>>> {
  const result = await tx.query(
    `SELECT v.id, v.status, v.document_type, v.invoice_number, v.invoice_date,
            v.currency, v.subtotal, v.tax_amount, v.total_amount, v.extracted_data,
            v.review_note, v.ai_confidence, v.created_at, v.updated_at,
            m.user_id AS submitted_by
     FROM temp_vouchers AS v
     LEFT JOIN tenant_memberships AS m
       ON m.tenant_id = v.tenant_id AND m.id = v.submitted_by_membership_id
     WHERE ($1 <> 'staff' OR v.submitted_by_membership_id = $2)
     ORDER BY v.created_at DESC LIMIT 200`
    , [role, membershipId]
  );
  return result.rows;
}

export async function getVoucherDocument(
  tx: TenantTransaction,
  tenantId: string,
  voucherId: string,
  role: AuthContext["role"],
  membershipId: string
): Promise<{ storageKey: string; mimeType: string } | null> {
  const result = await tx.query<{ storage_key: string; mime_type: string }>(
    `SELECT storage_key, mime_type FROM temp_vouchers
     WHERE tenant_id = $1 AND id = $2
       AND ($3 <> 'staff' OR submitted_by_membership_id = $4)`,
    [tenantId, voucherId, role, membershipId]
  );
  const row = result.rows[0];
  return row ? { storageKey: row.storage_key, mimeType: row.mime_type } : null;
}

export async function editVoucher(
  auth: AuthContext,
  voucherId: string,
  rawInput: unknown
): Promise<void> {
  const input = voucherEditSchema.parse(rawInput);
  if (input.invoiceDate && !isValidDate(input.invoiceDate)) {
    throw new HttpError(400, "Ngày hóa đơn không hợp lệ");
  }
  await withTenantTransaction(auth.tenantId, async (tx) => {
    const currentResult = await tx.query<{
      status: string;
      invoice_number: string | null;
      invoice_date: string | null;
      currency: string | null;
      subtotal: string | null;
      tax_amount: string | null;
      total_amount: string | null;
      extracted_data: Record<string, unknown>;
    }>(
      `SELECT status, invoice_number, invoice_date, currency, subtotal::text,
              tax_amount::text, total_amount::text, extracted_data
       FROM temp_vouchers WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [auth.tenantId, voucherId]
    );
    const current = currentResult.rows[0];
    if (!current) throw new HttpError(404, "Không tìm thấy chứng từ trong tenant hiện tại");
    if (current.status !== "needs_review") throw new HttpError(409, "Chỉ có thể sửa chứng từ đang chờ duyệt");
    const subtotal = input.subtotal !== undefined ? input.subtotal : current.subtotal;
    const tax = input.taxAmount !== undefined ? input.taxAmount : current.tax_amount;
    const total = input.totalAmount !== undefined ? input.totalAmount : current.total_amount;
    if (subtotal && tax && total && toScale4(subtotal) + toScale4(tax) !== toScale4(total)) {
      throw new HttpError(422, "Tổng tiền phải bằng tiền trước thuế cộng tiền thuế");
    }

    const extractedUpdates: Record<string, unknown> = {};
    if (input.supplierName !== undefined) extractedUpdates.supplierName = input.supplierName;
    if (input.invoiceNumber !== undefined) extractedUpdates.invoiceNumber = input.invoiceNumber;
    if (input.invoiceDate !== undefined) extractedUpdates.invoiceDate = input.invoiceDate;
    if (input.currency !== undefined) extractedUpdates.currency = input.currency;
    if (input.subtotal !== undefined) extractedUpdates.subtotal = input.subtotal === null ? null : Number(input.subtotal);
    if (input.taxAmount !== undefined) extractedUpdates.taxAmount = input.taxAmount === null ? null : Number(input.taxAmount);
    if (input.totalAmount !== undefined) extractedUpdates.totalAmount = input.totalAmount === null ? null : Number(input.totalAmount);
    await tx.query(
      `UPDATE temp_vouchers SET
         invoice_number = CASE WHEN $3 THEN $4 ELSE invoice_number END,
         invoice_date = CASE WHEN $5 THEN $6::date ELSE invoice_date END,
         currency = CASE WHEN $7 THEN $8 ELSE currency END,
         subtotal = CASE WHEN $9 THEN $10::numeric ELSE subtotal END,
         tax_amount = CASE WHEN $11 THEN $12::numeric ELSE tax_amount END,
         total_amount = CASE WHEN $13 THEN $14::numeric ELSE total_amount END,
         extracted_data = extracted_data || $15::jsonb,
         updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [
        auth.tenantId, voucherId,
        input.invoiceNumber !== undefined, input.invoiceNumber ?? null,
        input.invoiceDate !== undefined, input.invoiceDate ?? null,
        input.currency !== undefined, input.currency ?? null,
        input.subtotal !== undefined, input.subtotal ?? null,
        input.taxAmount !== undefined, input.taxAmount ?? null,
        input.totalAmount !== undefined, input.totalAmount ?? null,
        JSON.stringify(extractedUpdates)
      ]
    );
    await writeAudit(tx, auth, voucherId, "voucher.extraction_edited", {
      fields: Object.keys(extractedUpdates)
    });
  }, auth.userId);
}

export async function reviewVoucher(
  auth: AuthContext,
  voucherId: string,
  decision: "approve" | "reject",
  note?: string,
  accountMappingOverrides?: {
    expenseAccountCode: string;
    inputTaxAccountCode: string;
    payableAccountCode: string;
  }
): Promise<{ status: string }> {
  return withTenantTransaction(auth.tenantId, async (tx) => {
    const lock = await tx.query<{
      id: string;
      status: string;
      subtotal: string | null;
      tax_amount: string | null;
      total_amount: string | null;
      currency: string | null;
      invoice_date: string | null;
    }>(
      `SELECT id, status, subtotal::text, tax_amount::text, total_amount::text, currency, invoice_date
       FROM temp_vouchers WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [auth.tenantId, voucherId]
    );
    const voucher = lock.rows[0];
    if (!voucher) throw new HttpError(404, "Không tìm thấy chứng từ trong tenant hiện tại");
    if (voucher.status !== "needs_review") throw new HttpError(409, `Chứng từ đang ở trạng thái ${voucher.status}`);

    if (decision === "reject") {
      await tx.query(
        `UPDATE temp_vouchers SET status = 'rejected', review_note = $4,
         rejected_by_membership_id = $3, rejected_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [auth.tenantId, voucherId, auth.membershipId, note ?? null]
      );
      await writeAudit(tx, auth, voucherId, "voucher.rejected", { note: note ?? null });
      return { status: "rejected" };
    }

    if (!voucher.subtotal || !voucher.total_amount || !voucher.currency) {
      throw new HttpError(422, "Thiếu tổng tiền/tiền tệ; cần hoàn thiện dữ liệu chứng từ trước khi duyệt");
    }
    const subtotal = toScale4(voucher.subtotal);
    const tax = toScale4(voucher.tax_amount ?? "0");
    const total = toScale4(voucher.total_amount);
    if (total <= 0n) throw new HttpError(422, "Tổng tiền chứng từ phải lớn hơn 0");
    if (subtotal + tax !== total) throw new HttpError(422, "Tổng tiền không cân bằng với tiền trước thuế và thuế");

    const mappingKeys = ["expense", "input_tax", "accounts_payable"] as const;
    const overrideCodes = accountMappingOverrides
      ? [
          accountMappingOverrides.expenseAccountCode,
          accountMappingOverrides.inputTaxAccountCode,
          accountMappingOverrides.payableAccountCode
        ]
      : [];
    const accountMappings = accountMappingOverrides
      ? await tx.query<{ mapping_key: string | null; account_code: string; account_name: string }>(
          "SELECT NULL::text AS mapping_key, account_code, account_name FROM ledger_accounts WHERE account_code = ANY($1::text[])",
          [overrideCodes]
        )
      : await tx.query<{
          mapping_key: string | null;
          account_code: string;
          account_name: string;
        }>(
          `SELECT m.mapping_key, a.account_code, a.account_name
           FROM tenant_account_mappings m
           JOIN ledger_accounts a
             ON a.tenant_id = m.tenant_id AND a.account_code = m.account_code`
        );
    const mapped = accountMappingOverrides
      ? new Map(
          mappingKeys.map((key, index) => {
            const code = overrideCodes[index];
            return [key, accountMappings.rows.find((row) => row.account_code === code)];
          })
        )
      : new Map(
          accountMappings.rows.map((row) => [row.mapping_key ?? "", row])
        );
    const expenseAccount = mapped.get("expense");
    const taxAccount = mapped.get("input_tax");
    const payableAccount = mapped.get("accounts_payable");
    if (!expenseAccount || !payableAccount || (tax > 0n && !taxAccount)) {
      throw new HttpError(
        422,
        "Chưa cấu hình tài khoản định khoản. Hãy nhập sổ Excel và cấu hình tài khoản trong mục Sổ sách trước khi duyệt."
      );
    }

    await tx.query(
      `UPDATE temp_vouchers SET status = 'approved', review_note = $4,
       approved_by_membership_id = $3, approved_at = now(), updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [auth.tenantId, voucherId, auth.membershipId, note ?? null]
    );
    const entryId = randomUUID();
    const entryNumber = `NB-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${entryId.slice(0, 8).toUpperCase()}`;
    await tx.query(
      `INSERT INTO accounting_entries
        (tenant_id, id, voucher_id, entry_number, entry_date, description, currency,
         status, created_by_membership_id, posted_by_membership_id, posted_at)
       VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6, $7, 'draft', $8, NULL, NULL)`,
      [
        auth.tenantId, entryId, voucherId, entryNumber,
        voucher.invoice_date,
        `Ghi nhận chứng từ ${voucherId}`, voucher.currency, auth.membershipId
      ]
    );
    let lineNumber = 1;
    if (subtotal > 0n) {
      await tx.query(
        `INSERT INTO accounting_entry_lines
          (tenant_id, accounting_entry_id, line_number, account_code, account_name, debit)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [auth.tenantId, entryId, lineNumber++, expenseAccount.account_code, expenseAccount.account_name, voucher.subtotal]
      );
    }
    if (tax > 0n) {
      await tx.query(
        `INSERT INTO accounting_entry_lines
          (tenant_id, accounting_entry_id, line_number, account_code, account_name, debit)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [auth.tenantId, entryId, lineNumber++, taxAccount?.account_code, taxAccount?.account_name, voucher.tax_amount]
      );
    }
    await tx.query(
      `INSERT INTO accounting_entry_lines
        (tenant_id, accounting_entry_id, line_number, account_code, account_name, credit)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [auth.tenantId, entryId, lineNumber, payableAccount.account_code, payableAccount.account_name, voucher.total_amount]
    );
    await tx.query(
      `UPDATE accounting_entries
       SET status = 'posted', posted_by_membership_id = $3, posted_at = now(), updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status = 'draft'`,
      [auth.tenantId, entryId, auth.membershipId]
    );
    await tx.query(
      "UPDATE temp_vouchers SET status = 'posted', posted_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2",
      [auth.tenantId, voucherId]
    );
    await writeAudit(tx, auth, voucherId, "voucher.approved_and_posted", {
      entryId,
      entryNumber,
      note: note ?? null,
      accountMappings: {
        expense: expenseAccount.account_code,
        input_tax: tax > 0n ? taxAccount?.account_code : null,
        accounts_payable: payableAccount.account_code
      }
    });
    return { status: "posted" };
  }, auth.userId);
}

async function writeAudit(
  tx: TenantTransaction,
  auth: AuthContext,
  voucherId: string,
  action: string,
  details: Record<string, unknown>
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, details)
     VALUES ($1, $2, $3, 'temp_voucher', $4, $5)`,
    [auth.tenantId, auth.userId, action, voucherId, JSON.stringify(details)]
  );
}

function toScale4(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(value);
  if (!match?.[1]) throw new HttpError(422, "Số tiền không hợp lệ hoặc vượt quá 4 chữ số thập phân");
  return BigInt(match[1]) * 10_000n + BigInt((match[2] ?? "").padEnd(4, "0") || "0");
}

function isValidDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}
