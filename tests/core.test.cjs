process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = "test-secret-with-more-than-thirty-two-characters";
process.env.ENCRYPTION_KEY = "11".repeat(32);

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateDocument } = require("../dist/storage.js");
const { encryptJson, decryptJson, hashWebhookKey, constantTimeEqual } = require("../dist/crypto.js");
const { extractedInvoiceSchema } = require("../dist/gemini.js");
const { parseLedgerWorkbook, LedgerWorkbookError } = require("../dist/ledger.js");
const {
  createInventoryWorkbook, InventoryWorkbookError, parseInventoryWorkbook
} = require("../dist/inventory.js");
const { decimalToUnits, firstNegativeStockMovement } = require("../dist/inventory-service.js");
const ExcelJS = require("exceljs");
const {
  inventoryAssignmentSchema, inventoryMovementSchema, registerSchema, productSchema, supplierSchema
} = require("../dist/validation.js");

test("validates document bytes against declared media type", () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  assert.doesNotThrow(() => validateDocument(png, "image/png"));
  assert.throws(() => validateDocument(png, "image/jpeg"), /không khớp/);
  assert.throws(() => validateDocument(Buffer.from("not a pdf"), "application/pdf"), /không khớp/);
  assert.throws(() => validateDocument(png, "text/html"), /Chỉ chấp nhận/);
});

test("encrypts channel secrets and detects tampering", () => {
  const credentials = { token: "secret-token", chatId: "12345" };
  const encrypted = encryptJson(credentials);
  assert.notEqual(encrypted.toString("utf8"), JSON.stringify(credentials));
  assert.deepEqual(decryptJson(encrypted), credentials);
  const damaged = Buffer.from(encrypted);
  damaged[damaged.length - 1] ^= 0xff;
  assert.throws(() => decryptJson(damaged));
});

test("webhook route keys are one-way and comparisons are constant-time safe", () => {
  const firstHash = hashWebhookKey("private-route-key");
  assert.equal(firstHash.length, 32);
  assert.deepEqual(firstHash, hashWebhookKey("private-route-key"));
  assert.equal(constantTimeEqual("header-secret", "header-secret"), true);
  assert.equal(constantTimeEqual("header-secret", "wrong-secret"), false);
});

test("validates Gemini structured output before it can enter review", () => {
  const invoice = {
    supplierName: "Nhà cung cấp",
    supplierTaxId: null,
    invoiceNumber: "INV-001",
    invoiceDate: "2026-10-30",
    currency: "VND",
    subtotal: 100,
    taxAmount: 10,
    totalAmount: 110,
    lineItems: [{ description: "Hàng hóa", quantity: 1, unitPrice: 100, amount: 100 }],
    confidence: 0.9,
    warnings: []
  };
  assert.equal(extractedInvoiceSchema.parse(invoice).totalAmount, 110);
  assert.throws(() => extractedInvoiceSchema.parse({ ...invoice, currency: "vnd" }));
  assert.throws(() => extractedInvoiceSchema.parse({ ...invoice, totalAmount: 110.12345 }));
});

test("validates tenant registration and tenant-owned product fields", () => {
  assert.equal(registerSchema.safeParse({
    email: "admin@example.com",
    password: "A-long-test-password-2026",
    fullName: "Nguyen Van A",
    companyName: "Cong ty A",
    tenantSlug: "cong-ty-a"
  }).success, true);
  assert.equal(registerSchema.safeParse({
    email: "admin@example.com",
    password: "short",
    fullName: "Nguyen Van A",
    companyName: "Cong ty A",
    tenantSlug: "x"
  }).success, false);
  assert.equal(productSchema.safeParse({ code: "SKU1", name: "Dịch vụ kế toán" }).success, true);
  assert.equal(productSchema.safeParse({
    code: "SKU1", name: "Dịch vụ kế toán", defaultUnitPrice: null, taxRate: null
  }).success, true);
  assert.equal(supplierSchema.safeParse({
    code: "SUP1", name: "Nhà cung cấp", taxId: null, email: null
  }).success, true);
  assert.equal(supplierSchema.safeParse({
    code: "SUP1", name: "Nhà cung cấp", email: "not-an-email"
  }).success, false);
});

test("parses balanced multi-line ledger entries and extracts tenant account catalog", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("So cai");
  sheet.addRow(["Số bút toán", "Ngày hạch toán", "Diễn giải", "Tiền tệ", "Mã tài khoản", "Tên tài khoản", "Nợ", "Có"]);
  sheet.addRow(["CT-001", "2026-10-30", "Mua hàng", "VND", "156", "Hàng hóa", 100000, 0]);
  sheet.addRow(["CT-001", "2026-10-30", "Mua hàng", "VND", "331", "Phải trả", 0, 100000]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  const parsed = await parseLedgerWorkbook(buffer);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].lines.length, 2);
  assert.deepEqual(parsed.accounts, [
    { accountCode: "156", accountName: "Hàng hóa" },
    { accountCode: "331", accountName: "Phải trả" }
  ]);
});

test("rejects unbalanced entries and account codes with conflicting names", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("So cai");
  sheet.addRow(["entry_number", "entry_date", "description", "account_code", "account_name", "debit", "credit"]);
  sheet.addRow(["CT-001", "30/10/2026", "Mua hàng", "156", "Hàng hóa", 100, 0]);
  sheet.addRow(["CT-001", "30/10/2026", "Mua hàng", "331", "Phải trả", 0, 90]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  await assert.rejects(parseLedgerWorkbook(buffer), (error) => {
    assert.ok(error instanceof LedgerWorkbookError);
    assert.ok(error.details.some((detail) => detail.includes("tổng Nợ phải bằng tổng Có")));
    return true;
  });
});

test("exports a five-sheet stock workbook that can be imported without recalculating formulas", async () => {
  const buffer = await createInventoryWorkbook({
    items: [{
      code: "VT001", name: "Máy khoan", category: "Dụng cụ", unit: "Cái",
      minimumQuantity: "2", location: "Kệ A1", notes: null, openingQuantity: "10",
      currentQuantity: "15", totalIncoming: "5", totalOutgoing: "0", status: "Đủ tồn"
    }],
    movements: [{
      date: "2026-06-01", documentNumber: "NK001", type: "purchase_in", itemCode: "VT001",
      itemName: "Máy khoan", unit: "Cái", quantity: "5", recipient: "Nhà cung cấp",
      notes: null, rowNumber: 5
    }],
    assignments: [{
      documentNumber: "CP001", issuedAt: "2026-06-02", recipient: "Nguyen Van A", team: "To 1",
      itemCode: "VT001", quantity: "1", condition: "Đang sử dụng", dueDate: "2027-06-02",
      notes: null, status: "active", rowNumber: 5
    }]
  });
  const parsed = await parseInventoryWorkbook(buffer);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].openingQuantity, "10");
  assert.equal(parsed.movements[0].type, "purchase_in");
  assert.equal(parsed.assignments[0].status, "active");
  assert.deepEqual(
    ["Tổng Quan (Dashboard)", "Sổ Nhật Ký XNT", "Báo Cáo Tồn Kho", "Danh Mục Vật Tư", "Cấp Phát Thợ"],
    (await (async () => {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      return workbook.worksheets.map((sheet) => sheet.name);
    })())
  );
});

test("rejects workbook rows with uncached formulas or unsupported transaction types", async () => {
  const formulaWorkbook = new ExcelJS.Workbook();
  addInventorySheets(formulaWorkbook, { uncachedItemCode: true });
  await assert.rejects(
    parseInventoryWorkbook(Buffer.from(await formulaWorkbook.xlsx.writeBuffer())),
    (error) => error instanceof InventoryWorkbookError && /kết quả đã lưu/.test(error.message)
  );

  const unsupportedWorkbook = new ExcelJS.Workbook();
  addInventorySheets(unsupportedWorkbook, { transactionType: "Không xác định" });
  await assert.rejects(
    parseInventoryWorkbook(Buffer.from(await unsupportedWorkbook.xlsx.writeBuffer())),
    (error) => error instanceof InventoryWorkbookError
      && error.details.some((detail) => detail.includes("loại giao dịch chưa hỗ trợ"))
  );
});

test("validates stock movements and uses fixed-point arithmetic for quantities", () => {
  assert.equal(decimalToUnits("12.3456"), 123456n);
  assert.equal(firstNegativeStockMovement("1", [
    { type: "production_out", quantity: "0.5" },
    { type: "production_out", quantity: "0.6" }
  ]), 1);
  assert.equal(firstNegativeStockMovement("1", [
    { type: "purchase_in", quantity: "0.5" },
    { type: "production_out", quantity: "1.5" }
  ]), null);
  assert.equal(inventoryMovementSchema.safeParse({
    itemId: "e5b3cc79-1b2b-4ee9-9b82-a760340d96f0",
    date: "2026-06-01", documentNumber: "XK-1", type: "production_out", quantity: "1.25"
  }).success, true);
  assert.equal(inventoryMovementSchema.safeParse({
    itemId: "e5b3cc79-1b2b-4ee9-9b82-a760340d96f0",
    date: "2026-06-01", documentNumber: "XK-1", type: "production_out", quantity: "-1"
  }).success, false);
  assert.equal(inventoryAssignmentSchema.safeParse({
    itemId: "e5b3cc79-1b2b-4ee9-9b82-a760340d96f0",
    documentNumber: "CP-1", issuedAt: "2026-06-01", recipient: "Nguyen Van A", quantity: "1"
  }).success, true);
});

function addInventorySheets(workbook, options = {}) {
  const catalog = workbook.addWorksheet("Danh Mục Vật Tư");
  catalog.addRows([[], [], [], ["STT", "Mã Vật Tư", "Tên Vật Tư / Dụng Cụ", "Phân Loại", "Đơn Vị Tính", "Tồn Tối Thiểu", "Vị Trí Kho", "Ghi Chú"]]);
  catalog.addRow([1, "VT001", "Máy khoan", "Dụng cụ", "Cái", 2, "Kệ A1", ""]);

  const report = workbook.addWorksheet("Báo Cáo Tồn Kho");
  report.addRows([[], [], [], ["STT", "Mã VT", "Tên Vật Tư / Dụng Cụ", "Phân Loại", "ĐVT", "Tồn Đầu Kỳ"]]);
  report.addRow([
    1,
    options.uncachedItemCode ? { formula: "'Danh Mục Vật Tư'!B5" } : { formula: "'Danh Mục Vật Tư'!B5", result: "VT001" },
    "Máy khoan", "Dụng cụ", "Cái", 10
  ]);

  const journal = workbook.addWorksheet("Sổ Nhật Ký XNT");
  journal.addRows([[], [], [], ["STT", "Ngày Giao Dịch", "Mã Phiếu", "Loại Giao Dịch", "Mã Vật Tư", "Tên Vật Tư", "ĐVT", "Số Lượng", "Bộ Phận / Thợ Nhận", "Ghi Chú"]]);
  journal.addRow([1, "2026-06-01", "NK001", options.transactionType || "Nhập mua", "VT001", "Máy khoan", "Cái", 5, "Kho", ""]);

  const assignments = workbook.addWorksheet("Cấp Phát Thợ");
  assignments.addRows([[], [], [], ["STT", "Mã Phiếu", "Ngày Cấp", "Họ Tên Thợ", "Tổ / Nhóm", "Mã Dụng Cụ", "Tên Dụng Cụ / Thiết Bị", "Số Lượng", "Tình Trạng", "Hạn Thu Hồi / Kiểm Định", "Ghi Chú"]]);
  assignments.addRow([1, "CP001", "2026-06-02", "Nguyen Van A", "To 1", "VT001", "Máy khoan", 1, "Đang sử dụng", "2027-06-02", ""]);
}
