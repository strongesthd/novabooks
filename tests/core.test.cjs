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
const ExcelJS = require("exceljs");
const { registerSchema, productSchema, supplierSchema } = require("../dist/validation.js");

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
