import ExcelJS from "exceljs";

export type ImportedLedgerLine = {
  accountCode: string;
  accountName: string;
  description: string | null;
  debit: string;
  credit: string;
};

export type ImportedLedgerEntry = {
  entryNumber: string;
  entryDate: string;
  description: string;
  currency: string;
  lines: ImportedLedgerLine[];
};

export type ParsedLedgerWorkbook = {
  entries: ImportedLedgerEntry[];
  accounts: Array<{ accountCode: string; accountName: string }>;
  lineCount: number;
};

export class LedgerWorkbookError extends Error {
  constructor(message: string, readonly details: string[] = []) {
    super(message);
    this.name = "LedgerWorkbookError";
  }
}

const HEADER_ALIASES: Record<string, string[]> = {
  entryNumber: ["entry_number", "entry number", "so but toan", "so chung tu", "so ct", "ma but toan"],
  entryDate: ["entry_date", "entry date", "ngay hach toan", "ngay chung tu", "ngay"],
  description: ["description", "dien giai", "noi dung"],
  currency: ["currency", "tien te", "ma tien te"],
  accountCode: ["account_code", "account code", "ma tai khoan", "tai khoan", "ma tk"],
  accountName: ["account_name", "account name", "ten tai khoan", "ten tk"],
  lineDescription: ["line_description", "line description", "dien giai dong", "dien giai chi tiet"],
  debit: ["debit", "no", "phat sinh no", "so tien no"],
  credit: ["credit", "co", "phat sinh co", "so tien co"]
};

const REQUIRED_COLUMNS = [
  "entryNumber", "entryDate", "description", "accountCode", "accountName", "debit", "credit"
] as const;
const MAX_ROWS = 20_001;
const MAX_ERRORS = 50;

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function cellValue(value: ExcelJS.CellValue): unknown {
  if (value && typeof value === "object" && !((value instanceof Date))) {
    if ("formula" in value || "sharedFormula" in value) {
      throw new Error("Không hỗ trợ ô công thức; hãy dán giá trị tĩnh trước khi nhập.");
    }
    if ("richText" in value) return value.richText.map((item) => item.text).join("");
    if ("text" in value) return value.text;
    if ("result" in value) return value.result;
  }
  return value;
}

function text(value: ExcelJS.CellValue, label: string, rowNumber: number, maxLength: number): string {
  const raw = cellValue(value);
  const result = raw instanceof Date ? "" : String(raw ?? "").trim();
  if (!result) throw new Error(`${label} không được để trống.`);
  if (result.length > maxLength) throw new Error(`${label} vượt quá ${maxLength} ký tự.`);
  return result;
}

function parseDate(value: ExcelJS.CellValue): string {
  const raw = cellValue(value);
  let year: number;
  let month: number;
  let day: number;
  if (raw instanceof Date) {
    year = raw.getUTCFullYear();
    month = raw.getUTCMonth() + 1;
    day = raw.getUTCDate();
  } else if (typeof raw === "number" && Number.isFinite(raw)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.trunc(raw) * 86_400_000);
    year = date.getUTCFullYear();
    month = date.getUTCMonth() + 1;
    day = date.getUTCDate();
  } else {
    const valueText = String(raw ?? "").trim();
    let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(valueText);
    if (match) {
      year = Number(match[1]);
      month = Number(match[2]);
      day = Number(match[3]);
    } else {
      match = /^(\d{1,2})[/. -](\d{1,2})[/. -](\d{4})$/.exec(valueText);
      if (!match) throw new Error("Ngày phải có dạng YYYY-MM-DD hoặc DD/MM/YYYY.");
      day = Number(match[1]);
      month = Number(match[2]);
      year = Number(match[3]);
    }
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error("Ngày không hợp lệ.");
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function decimalText(value: ExcelJS.CellValue, label: string): string {
  const raw = cellValue(value);
  if (raw === null || raw === undefined || raw === "") return "0";
  let normalized: string;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0 || Math.abs(raw - Number(raw.toFixed(4))) > 0.0000001) {
      throw new Error(`${label} phải là số không âm, tối đa 4 chữ số thập phân.`);
    }
    normalized = raw.toFixed(4).replace(/\.?0+$/, "");
  } else {
    normalized = String(raw).trim().replace(/[\s\u00a0]/g, "").replace(/[₫đ]/gi, "");
    if (!normalized) return "0";
    if (!/^[\d.,]+$/.test(normalized)) throw new Error(`${label} không phải số hợp lệ.`);
    const lastDot = normalized.lastIndexOf(".");
    const lastComma = normalized.lastIndexOf(",");
    if (lastDot >= 0 && lastComma >= 0) {
      const decimalSeparator = lastDot > lastComma ? "." : ",";
      const thousandsSeparator = decimalSeparator === "." ? "," : ".";
      normalized = normalized.split(thousandsSeparator).join("");
      if (decimalSeparator === ",") normalized = normalized.replace(",", ".");
    } else if (lastComma >= 0 || lastDot >= 0) {
      const separator = lastComma >= 0 ? "," : ".";
      const pieces = normalized.split(separator);
      if (pieces.length > 2 || (pieces[pieces.length - 1] ?? "").length === 3) {
        normalized = pieces.join("");
      } else if (separator === ",") {
        normalized = normalized.replace(",", ".");
      }
    }
  }
  if (!/^\d+(?:\.\d{1,4})?$/.test(normalized)) {
    throw new Error(`${label} phải là số không âm, tối đa 4 chữ số thập phân.`);
  }
  return normalized;
}

function scaledAmount(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, "0"));
}

export async function parseLedgerWorkbook(buffer: Buffer): Promise<ParsedLedgerWorkbook> {
  const workbook = new ExcelJS.Workbook();
  try {
    const workbookBuffer = Buffer.from(buffer);
    const excelBuffer = workbookBuffer as unknown as Parameters<typeof workbook.xlsx.load>[0];
    await workbook.xlsx.load(excelBuffer);
  } catch {
    throw new LedgerWorkbookError("Không đọc được Excel. Hãy tải tệp .xlsx hợp lệ.");
  }
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount < 2) {
    throw new LedgerWorkbookError("Workbook cần có một sheet với dòng tiêu đề và ít nhất một dòng dữ liệu.");
  }
  if (sheet.rowCount > MAX_ROWS) {
    throw new LedgerWorkbookError(`Tệp vượt giới hạn ${MAX_ROWS - 1} dòng dữ liệu.`);
  }

  const headerRow = sheet.getRow(1);
  const columns = new Map<string, number>();
  headerRow.eachCell((cell, column) => {
    const header = normalizeHeader(cell.value);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(header)) columns.set(field, column);
    }
  });
  const missing = REQUIRED_COLUMNS.filter((field) => !columns.has(field));
  if (missing.length) {
    throw new LedgerWorkbookError(
      `Thiếu cột bắt buộc: ${missing.map((field) => HEADER_ALIASES[field]?.[0] ?? field).join(", ")}.`,
      ["Tải mẫu Excel NovaBooks để xem tên cột được hỗ trợ."]
    );
  }

  const entries = new Map<string, ImportedLedgerEntry>();
  const accounts = new Map<string, string>();
  const errors: string[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    let hasData = false;
    row.eachCell((cell) => {
      if (cell.value !== null && cell.value !== undefined && cell.value !== "") hasData = true;
    });
    if (!hasData) continue;
    try {
      const read = (field: string): ExcelJS.CellValue => row.getCell(columns.get(field) ?? 0).value;
      const entryNumber = text(read("entryNumber"), "Số bút toán", rowNumber, 100);
      const entryDate = parseDate(read("entryDate"));
      const description = text(read("description"), "Diễn giải", rowNumber, 500);
      const currency = columns.has("currency")
        ? text(read("currency"), "Tiền tệ", rowNumber, 3).toUpperCase()
        : "VND";
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Mã tiền tệ phải gồm 3 chữ cái, ví dụ VND.");
      const accountCode = text(read("accountCode"), "Mã tài khoản", rowNumber, 64).toUpperCase();
      const accountName = text(read("accountName"), "Tên tài khoản", rowNumber, 200);
      const lineDescription = columns.has("lineDescription")
        ? String(cellValue(read("lineDescription")) ?? "").trim().slice(0, 500) || null
        : null;
      const debit = decimalText(read("debit"), "Phát sinh Nợ");
      const credit = decimalText(read("credit"), "Phát sinh Có");
      const debitValue = scaledAmount(debit);
      const creditValue = scaledAmount(credit);
      if ((debitValue > 0n) === (creditValue > 0n)) {
        throw new Error("Mỗi dòng phải có đúng một giá trị Nợ hoặc Có lớn hơn 0.");
      }

      const existing = entries.get(entryNumber);
      if (existing && (
        existing.entryDate !== entryDate
        || existing.description !== description
        || existing.currency !== currency
      )) {
        throw new Error("Các dòng cùng số bút toán phải thống nhất ngày, diễn giải và tiền tệ.");
      }
      const entry = existing ?? { entryNumber, entryDate, description, currency, lines: [] };
      entry.lines.push({ accountCode, accountName, description: lineDescription, debit, credit });
      entries.set(entryNumber, entry);

      const previousName = accounts.get(accountCode);
      if (previousName && previousName !== accountName) {
        throw new Error(`Mã tài khoản ${accountCode} có nhiều tên khác nhau trong file.`);
      }
      accounts.set(accountCode, accountName);
    } catch (error) {
      if (errors.length < MAX_ERRORS) {
        errors.push(`Dòng ${rowNumber}: ${error instanceof Error ? error.message : "Dữ liệu không hợp lệ."}`);
      }
    }
  }

  for (const entry of entries.values()) {
    const debit = entry.lines.reduce((sum, line) => sum + scaledAmount(line.debit), 0n);
    const credit = entry.lines.reduce((sum, line) => sum + scaledAmount(line.credit), 0n);
    if (entry.lines.length < 2 || debit <= 0n || debit !== credit) {
      if (errors.length < MAX_ERRORS) {
        errors.push(`Bút toán ${entry.entryNumber}: cần ít nhất 2 dòng và tổng Nợ phải bằng tổng Có.`);
      }
    }
  }
  if (errors.length) {
    throw new LedgerWorkbookError("Excel có dòng dữ liệu cần sửa trước khi nhập.", errors);
  }
  if (!entries.size) throw new LedgerWorkbookError("Không tìm thấy bút toán hợp lệ để nhập.");

  return {
    entries: [...entries.values()],
    accounts: [...accounts].map(([accountCode, accountName]) => ({ accountCode, accountName })),
    lineCount: [...entries.values()].reduce((sum, entry) => sum + entry.lines.length, 0)
  };
}

export async function createLedgerTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "NovaBooks";
  const sheet = workbook.addWorksheet("So cai");
  sheet.columns = [
    { header: "Số bút toán", key: "entryNumber", width: 20 },
    { header: "Ngày hạch toán", key: "entryDate", width: 18 },
    { header: "Diễn giải", key: "description", width: 34 },
    { header: "Tiền tệ", key: "currency", width: 12 },
    { header: "Mã tài khoản", key: "accountCode", width: 18 },
    { header: "Tên tài khoản", key: "accountName", width: 26 },
    { header: "Diễn giải dòng", key: "lineDescription", width: 30 },
    { header: "Nợ", key: "debit", width: 18 },
    { header: "Có", key: "credit", width: 18 }
  ];
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF187B5A" } };
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  const instructions = workbook.addWorksheet("Huong dan");
  instructions.addRows([
    ["Mẫu nhập sổ cái NovaBooks"],
    ["Mỗi dòng là một tài khoản trong một bút toán; lặp lại số bút toán cho các dòng cùng bút toán."],
    ["Tổng Nợ phải bằng tổng Có cho từng số bút toán; mỗi dòng chỉ nhập Nợ hoặc Có."],
    ["Ngày nhập dạng YYYY-MM-DD hoặc DD/MM/YYYY; mã tiền tệ gồm 3 ký tự (mặc định VND nếu bỏ trống)."],
    ["Không sửa tên cột ở dòng đầu sheet So cai; không nhập công thức."]
  ]);
  instructions.getColumn(1).width = 110;
  instructions.getRow(1).font = { bold: true, size: 14 };
  const result = await workbook.xlsx.writeBuffer();
  return Buffer.from(result);
}
