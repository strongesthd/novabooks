import { randomUUID } from "node:crypto";
import { AuthContext } from "./types";
import { getMovementDirection, InventoryMovementType } from "./inventory";
import { TenantTransaction } from "./db";
import { HttpError } from "./http-error";

export type InventoryMovementInput = {
  itemId: string;
  date: string;
  documentNumber: string;
  type: InventoryMovementType;
  quantity: string;
  recipient?: string | null;
  notes?: string | null;
};

export type InventoryReviewLine = {
  lineIndex: number;
  itemId: string;
  quantity: string;
  amount: string;
};

export async function currentInventoryQuantity(
  tx: TenantTransaction,
  tenantId: string,
  itemId: string
): Promise<string> {
  const result = await tx.query<{ quantity: string }>(
    `SELECT (i.opening_quantity + COALESCE(sum(
       CASE WHEN m.movement_type IN ('purchase_in', 'return_in', 'adjustment_in') THEN m.quantity
            ELSE -m.quantity END
     ), 0))::text AS quantity
     FROM inventory_items i
     LEFT JOIN inventory_movements m
       ON m.tenant_id = i.tenant_id AND m.item_id = i.id
     WHERE i.tenant_id = $1 AND i.id = $2
     GROUP BY i.tenant_id, i.id`,
    [tenantId, itemId]
  );
  const quantity = result.rows[0]?.quantity;
  if (quantity === undefined) throw new HttpError(404, "Không tìm thấy vật tư trong tenant hiện tại");
  return quantity;
}

export async function createInventoryMovement(
  tx: TenantTransaction,
  auth: AuthContext,
  input: InventoryMovementInput
): Promise<void> {
  const item = await tx.query<{ id: string; status: string; opening_date: string }>(
    "SELECT id, status, opening_date::text FROM inventory_items WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
    [auth.tenantId, input.itemId]
  );
  if (!item.rows[0]) throw new HttpError(404, "Không tìm thấy vật tư trong tenant hiện tại");
  if (item.rows[0].status !== "active") throw new HttpError(409, "Không thể ghi giao dịch cho vật tư đã lưu trữ");
  if (input.date < item.rows[0].opening_date) {
    throw new HttpError(422, "Ngày giao dịch không được trước ngày tồn đầu kỳ của vật tư");
  }
  if (getMovementDirection(input.type) < 0) {
    const latest = await tx.query<{ movement_date: string | null }>(
      "SELECT max(movement_date)::text AS movement_date FROM inventory_movements WHERE tenant_id = $1 AND item_id = $2",
      [auth.tenantId, input.itemId]
    );
    if (latest.rows[0]?.movement_date && input.date <= latest.rows[0].movement_date) {
      throw new HttpError(409, "Giao dịch xuất phải sau nhật ký kho hiện có; không thể ghi xuất lùi ngày");
    }
  }
  await ensureNonnegativeStock(tx, auth.tenantId, input.itemId, input.type, input.quantity);
  const movementId = randomUUID();
  await tx.query(
    `INSERT INTO inventory_movements
       (tenant_id, id, item_id, movement_date, document_number, movement_type, quantity,
        recipient, notes, source_kind, source_key, created_by_membership_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual', $10, $11)`,
    [
      auth.tenantId, movementId, input.itemId, input.date, input.documentNumber, input.type,
      input.quantity, input.recipient ?? null, input.notes ?? null, `manual:${movementId}`, auth.membershipId
    ]
  );
  await writeInventoryAudit(tx, auth, "inventory.movement_created", "inventory_movement", movementId, {
    itemId: input.itemId,
    type: input.type,
    quantity: input.quantity,
    documentNumber: input.documentNumber
  });
}

export async function createInventoryAssignment(
  tx: TenantTransaction,
  auth: AuthContext,
  input: {
    itemId: string;
    documentNumber: string;
    issuedAt: string;
    recipient: string;
    team?: string | null;
    quantity: string;
    condition?: string | null;
    dueDate?: string | null;
    notes?: string | null;
  }
): Promise<string> {
  const item = await tx.query<{ id: string; status: string; opening_date: string }>(
    "SELECT id, status, opening_date::text FROM inventory_items WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
    [auth.tenantId, input.itemId]
  );
  if (!item.rows[0]) throw new HttpError(404, "Không tìm thấy vật tư trong tenant hiện tại");
  if (item.rows[0].status !== "active") throw new HttpError(409, "Không thể cấp phát vật tư đã lưu trữ");
  if (input.issuedAt < item.rows[0].opening_date) {
    throw new HttpError(422, "Ngày cấp phát không được trước ngày tồn đầu kỳ của vật tư");
  }
  const latest = await tx.query<{ movement_date: string | null }>(
    "SELECT max(movement_date)::text AS movement_date FROM inventory_movements WHERE tenant_id = $1 AND item_id = $2",
    [auth.tenantId, input.itemId]
  );
  if (latest.rows[0]?.movement_date && input.issuedAt <= latest.rows[0].movement_date) {
    throw new HttpError(409, "Ngày cấp phát phải sau nhật ký kho hiện có");
  }
  await ensureNonnegativeStock(tx, auth.tenantId, input.itemId, "issue_out", input.quantity);
  const assignmentId = randomUUID();
  await tx.query(
    `INSERT INTO inventory_assignments
       (tenant_id, id, item_id, document_number, issued_at, recipient, team, quantity,
        condition, due_date, notes, source_kind, created_by_membership_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'manual', $12)`,
    [
      auth.tenantId, assignmentId, input.itemId, input.documentNumber, input.issuedAt,
      input.recipient, input.team ?? null, input.quantity, input.condition ?? null,
      input.dueDate ?? null, input.notes ?? null, auth.membershipId
    ]
  );
  await tx.query(
    `INSERT INTO inventory_movements
       (tenant_id, item_id, movement_date, document_number, movement_type, quantity,
        recipient, notes, source_kind, source_key, source_assignment_id, created_by_membership_id)
     VALUES ($1, $2, $3, $4, 'issue_out', $5, $6, $7, 'assignment', $8, $9, $10)`,
    [
      auth.tenantId, input.itemId, input.issuedAt, input.documentNumber, input.quantity,
      input.recipient, input.notes ?? null, `assignment:${assignmentId}:issue`,
      assignmentId, auth.membershipId
    ]
  );
  await writeInventoryAudit(tx, auth, "inventory.assignment_created", "inventory_assignment", assignmentId, {
    itemId: input.itemId,
    quantity: input.quantity,
    recipient: input.recipient,
    documentNumber: input.documentNumber
  });
  return assignmentId;
}

export async function returnInventoryAssignment(
  tx: TenantTransaction,
  auth: AuthContext,
  assignmentId: string
): Promise<void> {
  const result = await tx.query<{
    id: string;
    item_id: string;
    document_number: string;
    issued_at: string;
    recipient: string;
    quantity: string;
    status: string;
  }>(
    `SELECT id, item_id, document_number, issued_at, recipient, quantity::text, status
     FROM inventory_assignments
     WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [auth.tenantId, assignmentId]
  );
  const assignment = result.rows[0];
  if (!assignment) throw new HttpError(404, "Không tìm thấy phiếu cấp phát trong tenant hiện tại");
  if (assignment.status !== "active") throw new HttpError(409, "Phiếu cấp phát đã được thu hồi");
  const item = await tx.query<{ id: string }>(
    "SELECT id FROM inventory_items WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
    [auth.tenantId, assignment.item_id]
  );
  if (!item.rows[0]) throw new HttpError(409, "Vật tư của phiếu cấp phát không còn khả dụng");

  const movementId = randomUUID();
  await tx.query(
    `INSERT INTO inventory_movements
       (tenant_id, id, item_id, movement_date, document_number, movement_type, quantity,
        recipient, notes, source_kind, source_key, source_assignment_id, created_by_membership_id)
     VALUES ($1, $2, $3, CURRENT_DATE, $4, 'return_in', $5, $6, $7, 'assignment', $8, $9, $10)`,
    [
      auth.tenantId, movementId, assignment.item_id, assignment.document_number,
      assignment.quantity, assignment.recipient, "Thu hồi dụng cụ cấp phát",
      `assignment:${assignmentId}:return`, assignmentId, auth.membershipId
    ]
  );
  await tx.query(
    `UPDATE inventory_assignments
     SET status = 'returned', returned_at = now()
     WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
    [auth.tenantId, assignmentId]
  );
  await writeInventoryAudit(tx, auth, "inventory.assignment_returned", "inventory_assignment", assignmentId, {
    quantity: assignment.quantity,
    documentNumber: assignment.document_number
  });
}

export async function postVoucherInventory(
  tx: TenantTransaction,
  auth: AuthContext,
  voucher: { id: string; invoiceNumber: string | null; invoiceDate: string | null },
  lines: InventoryReviewLine[]
): Promise<string> {
  if (!lines.length) return "0";
  const itemIds = [...new Set(lines.map((line) => line.itemId))].sort();
  const items = await tx.query<{ id: string; status: string; opening_date: string }>(
    `SELECT id, status, opening_date::text FROM inventory_items
     WHERE tenant_id = $1 AND id = ANY($2::uuid[])
     ORDER BY id FOR UPDATE`,
    [auth.tenantId, itemIds]
  );
  const byId = new Map(items.rows.map((item) => [item.id, item]));
  const missing = itemIds.filter((itemId) => !byId.has(itemId));
  if (missing.length) throw new HttpError(422, "Một hoặc nhiều vật tư đã chọn không tồn tại trong tenant hiện tại");
  if (items.rows.some((item) => item.status !== "active")) {
    throw new HttpError(422, "Không thể nhập kho vào vật tư đã lưu trữ");
  }
  if (voucher.invoiceDate && items.rows.some((item) => voucher.invoiceDate! < item.opening_date)) {
    throw new HttpError(422, "Ngày hóa đơn trước ngày tồn đầu kỳ của vật tư được ghép");
  }

  const seenLineIndexes = new Set<number>();
  let total = 0n;
  for (const line of lines) {
    if (seenLineIndexes.has(line.lineIndex)) throw new HttpError(422, "Một dòng hóa đơn chỉ được ghép với một vật tư");
    seenLineIndexes.add(line.lineIndex);
    const quantity = decimalToUnits(line.quantity);
    const amount = decimalToUnits(line.amount);
    if (quantity <= 0n || amount <= 0n) throw new HttpError(422, "Số lượng và thành tiền dòng nhập kho phải lớn hơn 0");
    total += amount;
  }

  const sourceDocument = voucher.invoiceNumber?.trim() || `OCR-${voucher.id.slice(0, 8).toUpperCase()}`;
  for (const line of lines) {
    await tx.query(
      `INSERT INTO inventory_movements
         (tenant_id, item_id, movement_date, document_number, movement_type, quantity,
          notes, source_kind, source_voucher_id, source_line_index, created_by_membership_id)
       VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4, 'purchase_in', $5,
          'Nhập từ hóa đơn đã duyệt', 'voucher', $6, $7, $8)`,
      [
        auth.tenantId, line.itemId, voucher.invoiceDate, sourceDocument, line.quantity,
        voucher.id, line.lineIndex, auth.membershipId
      ]
    );
  }
  return unitsToDecimal(total);
}

export async function ensureNonnegativeStock(
  tx: TenantTransaction,
  tenantId: string,
  itemId: string,
  type: InventoryMovementType,
  quantity: string
): Promise<void> {
  const direction = getMovementDirection(type);
  if (direction > 0) return;
  const current = decimalToUnits(await currentInventoryQuantity(tx, tenantId, itemId));
  if (current < decimalToUnits(quantity)) {
    throw new HttpError(409, "Không đủ tồn kho cho giao dịch xuất; hãy kiểm tra số dư và nhật ký kho");
  }
}

export function firstNegativeStockMovement(
  openingQuantity: string,
  movements: Array<{ type: InventoryMovementType; quantity: string }>
): number | null {
  let balance = decimalToUnits(openingQuantity);
  for (const [index, movement] of movements.entries()) {
    balance += BigInt(getMovementDirection(movement.type)) * decimalToUnits(movement.quantity);
    if (balance < 0n) return index;
  }
  return null;
}

export function decimalToUnits(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(value);
  if (!match?.[1]) throw new HttpError(422, "Số lượng hoặc giá trị kho không hợp lệ");
  return BigInt(match[1]) * 10_000n + BigInt((match[2] ?? "").padEnd(4, "0") || "0");
}

function unitsToDecimal(value: bigint): string {
  const whole = value / 10_000n;
  const fraction = (value % 10_000n).toString().padStart(4, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function writeInventoryAudit(
  tx: TenantTransaction,
  auth: AuthContext,
  action: string,
  resourceType: string,
  resourceId: string,
  details: Record<string, unknown>
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [auth.tenantId, auth.userId, action, resourceType, resourceId, JSON.stringify(details)]
  );
}
