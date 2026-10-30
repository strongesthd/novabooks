import ExcelJS from "exceljs";

export type InventoryMovementType =
  | "purchase_in"
  | "production_out"
  | "issue_out"
  | "return_in"
  | "adjustment_in"
  | "adjustment_out";

export type InventoryCatalogEntry = {
  code: string;
  name: string;
  category: string | null;
  unit: string | null;
  minimumQuantity: string;
  location: string | null;
  notes: string | null;
  openingQuantity: string;
};

export type InventoryMovementInput = {
  date: string;
  documentNumber: string;
  type: InventoryMovementType;
  itemCode: string;
  itemName: string;
  unit: string | null;
  quantity: string;
  recipient: string | null;
  notes: string | null;
  rowNumber: number;
};

export type InventoryAssignmentInput = {
  documentNumber: string;
  issuedAt: string;
  recipient: string;
  team: string | null;
  itemCode: string;
  quantity: string;
  condition: string | null;
  dueDate: string | null;
  notes: string | null;
  status: "active" | "returned";
  rowNumber: number;
};

export type ParsedInventoryWorkbook = {
  items: InventoryCatalogEntry[];
  movements: InventoryMovementInput[];
  assignments: InventoryAssignmentInput[];
  lineCount: number;
};

export type InventoryExportData = {
  items: Array<InventoryCatalogEntry & {
    currentQuantity: string;
    totalIncoming: string;
    totalOutgoing: string;
    status: string;
  }>;
  movements: Array<InventoryMovementInput>;
  assignments: Array<InventoryAssignmentInput>;
};

const HEADER_ROW = 4;
const MAX_ITEMS = 10_000;
const MAX_MOVEMENTS = 20_000;
const MAX_ASSIGNMENTS = 10_000;

const aliases = {
  code: ["mavattu", "mavt", "masanpham", "madungcu", "mahang"],
  name: ["tenvattu", "tenhanghoa", "tensanpham", "tendungcu", "tenvattudungcu", "tendungcuthietbi"],
  category: ["phanloai", "nhomvattu", "loaihang", "nhomhang"],
  unit: ["donvi", "dvt", "donvitinh"],
  minimum: ["tontoithieu", "muctontoithieu", "tonmin"],
  location: ["vitri", "vitrikho", "khuvuc"],
  notes: ["ghichu", "mota"],
  opening: ["tondauky", "tondau", "soluongdauky", "tonbandau"],
  date: ["ngay", "ngaygiaodich", "ngaynhapxuat", "ngaycap"],
  document: ["maphieu", "sophieu", "sovanban", "sochungtu", "maphieucap"],
  transactionType: ["loaigiaodich", "loaiphieu", "nghiepvu", "loainghiepvu"],
  quantity: ["soluong", "sl", "soluongnhapxuat"],
  recipient: ["noinhan", "nguoinhan", "nguoisudung", "nguoicap", "bophanthonhan", "hotentho"],
  team: ["bophan", "nhom", "nhomtho", "to", "tonhom"],
  condition: ["tinhtrang", "tinhtrangdungcu", "trangthai"],
  dueDate: ["hanthuh hoi", "hanthuhoi", "ngaydukientra", "hannop", "hanthuhoikiemdinh"],
  returned: ["ngaythuhoi", "ngaytra"]
} as const;

const movementNames: Array<[RegExp, InventoryMovementType]> = [
  [/^(nhapmua|nhapmoi|nhapkho|nhap hang|nhap hang hoa|nhap hanghoa|nhapvattu)$/, "purchase_in"],
  [/^(xuat san xuat|xuatsanxuat|xuatdung|xuatdungcu|xuatvattu|xuatkhac)$/, "production_out"],
  [/^(cap phat tho|capphattho|cap phat|capphat)$/, "issue_out"],
  [/^(thu hoi|thuhoi|nhap tra|nhaptra|hang tra|hangtra|tra kho|trakho)$/, "return_in"],
  [/^(dieu chinh tang|dieuchinhtang|nhap dieu chinh|nhapdieuchinh)$/, "adjustment_in"],
  [/^(dieu chinh giam|dieuchinhgiam|xuat dieu chinh|xuatdieuchinh)$/, "adjustment_out"]
];

export class InventoryWorkbookError extends Error {
  constructor(message: string, public readonly details: string[] = []) {
    super(message);
  }
}

export async function parseInventoryWorkbook(buffer: Buffer): Promise<ParsedInventoryWorkbook> {
  const workbook = new ExcelJS.Workbook();
  try {
    const workbookBuffer = Buffer.from(buffer) as unknown as Parameters<typeof workbook.xlsx.load>[0];
    await workbook.xlsx.load(workbookBuffer);
  } catch (error) {
    throw new InventoryWorkbookError("Không thể đọc workbook Excel.", [
      error instanceof Error ? error.message : "Tệp không phải workbook .xlsx hợp lệ."
    ]);
  }

  const catalogSheet = findSheet(workbook, ["danh muc vat tu", "danh muc vat lieu", "danh muc hang hoa"]);
  const reportSheet = findSheet(workbook, ["bao cao ton kho", "bao cao ton"]);
  const journalSheet = findSheet(workbook, ["so nhat ky xnt", "so nhat ky nhap xuat ton", "nhat ky xnt"]);
  const assignmentSheet = findSheet(workbook, ["cap phat tho", "cap phat dung cu"]);
  const details: string[] = [];
  if (!catalogSheet) details.push("Thiếu sheet Danh Mục Vật Tư.");
  if (!reportSheet) details.push("Thiếu sheet Báo Cáo Tồn Kho để lấy số dư đầu kỳ.");
  if (!journalSheet) details.push("Thiếu sheet Sổ Nhật Ký XNT.");
  if (details.length || !catalogSheet || !reportSheet || !journalSheet) {
    throw new InventoryWorkbookError("Workbook chưa đúng cấu trúc sổ kho NovaBooks.", details);
  }

  const catalogColumns = readColumns(catalogSheet, {
    code: aliases.code,
    name: aliases.name,
    category: aliases.category,
    unit: aliases.unit,
    minimum: aliases.minimum,
    location: aliases.location,
    notes: aliases.notes
  }, ["code", "name"]);
  const reportColumns = readColumns(reportSheet, {
    code: aliases.code,
    opening: aliases.opening
  }, ["code", "opening"]);
  const journalColumns = readColumns(journalSheet, {
    date: aliases.date,
    document: aliases.document,
    transactionType: aliases.transactionType,
    code: aliases.code,
    name: aliases.name,
    unit: aliases.unit,
    quantity: aliases.quantity,
    recipient: aliases.recipient,
    notes: aliases.notes
  }, ["date", "document", "transactionType", "code", "quantity"]);

  const reportBalances = new Map<string, string>();
  const reportRows: string[] = [];
  for (let rowNumber = HEADER_ROW + 1; rowNumber <= reportSheet.rowCount; rowNumber += 1) {
    const row = reportSheet.getRow(rowNumber);
    if (isEmptyRow(row)) continue;
    const code = textAt(row, reportColumns.code);
    if (!code && isSummaryRow(row)) continue;
    const balance = decimalAt(row, reportColumns.opening, `Báo Cáo Tồn Kho!${rowNumber}`);
    if (!code) {
      reportRows.push(`Báo Cáo Tồn Kho dòng ${rowNumber}: thiếu mã vật tư.`);
      continue;
    }
    const key = normalizeCode(code);
    if (reportBalances.has(key)) {
      reportRows.push(`Báo Cáo Tồn Kho dòng ${rowNumber}: mã vật tư ${code} bị trùng.`);
      continue;
    }
    reportBalances.set(key, balance ?? "0");
  }

  const items: InventoryCatalogEntry[] = [];
  const itemCodes = new Map<string, string>();
  for (let rowNumber = HEADER_ROW + 1; rowNumber <= catalogSheet.rowCount; rowNumber += 1) {
    const row = catalogSheet.getRow(rowNumber);
    if (isEmptyRow(row)) continue;
    const code = textAt(row, catalogColumns.code);
    const name = textAt(row, catalogColumns.name);
    if (!code || !name) {
      reportRows.push(`Danh Mục Vật Tư dòng ${rowNumber}: thiếu mã hoặc tên vật tư.`);
      continue;
    }
    const key = normalizeCode(code);
    if (itemCodes.has(key)) {
      reportRows.push(`Danh Mục Vật Tư dòng ${rowNumber}: mã vật tư ${code} bị trùng.`);
      continue;
    }
    itemCodes.set(key, code);
    items.push({
      code,
      name,
      category: optionalTextAt(row, catalogColumns.category),
      unit: optionalTextAt(row, catalogColumns.unit),
      minimumQuantity: decimalAt(row, catalogColumns.minimum, `Danh Mục Vật Tư!${rowNumber}`) ?? "0",
      location: optionalTextAt(row, catalogColumns.location),
      notes: optionalTextAt(row, catalogColumns.notes),
      openingQuantity: reportBalances.get(key) ?? "0"
    });
  }
  for (const [key] of reportBalances) {
    if (!itemCodes.has(key)) {
      reportRows.push(`Báo Cáo Tồn Kho: mã vật tư ${key} không có trong Danh Mục Vật Tư.`);
    }
  }

  const movements: InventoryMovementInput[] = [];
  const movementKeys = new Set<string>();
  for (let rowNumber = HEADER_ROW + 1; rowNumber <= journalSheet.rowCount; rowNumber += 1) {
    const row = journalSheet.getRow(rowNumber);
    if (isEmptyRow(row)) continue;
    const itemCode = textAt(row, journalColumns.code);
    const documentNumber = textAt(row, journalColumns.document);
    const typeLabel = textAt(row, journalColumns.transactionType);
    if (!itemCode && !documentNumber && !typeLabel) continue;
    const date = dateAt(row, journalColumns.date, `Sổ Nhật Ký XNT!${rowNumber}`);
    const quantity = decimalAt(row, journalColumns.quantity, `Sổ Nhật Ký XNT!${rowNumber}`);
    const type = parseMovementType(typeLabel);
    if (!itemCode || !documentNumber || !date || !quantity || !type) {
      reportRows.push(`Sổ Nhật Ký XNT dòng ${rowNumber}: thiếu mã vật tư, mã phiếu, ngày, số lượng hợp lệ hoặc loại giao dịch chưa hỗ trợ (${typeLabel || "trống"}).`);
      continue;
    }
    if (!itemCodes.has(normalizeCode(itemCode))) {
      reportRows.push(`Sổ Nhật Ký XNT dòng ${rowNumber}: mã vật tư ${itemCode} không có trong danh mục.`);
      continue;
    }
    const key = [date, normalizeCode(documentNumber), normalizeCode(itemCode), type, quantity].join("|");
    if (movementKeys.has(key)) {
      reportRows.push(`Sổ Nhật Ký XNT dòng ${rowNumber}: giao dịch ${documentNumber}/${itemCode} bị lặp.`);
      continue;
    }
    movementKeys.add(key);
    const catalogItem = items.find((item) => normalizeCode(item.code) === normalizeCode(itemCode));
    if (!catalogItem) {
      reportRows.push(`Sổ Nhật Ký XNT dòng ${rowNumber}: không tìm thấy mã vật tư ${itemCode}.`);
      continue;
    }
    movements.push({
      date,
      documentNumber,
      type,
      itemCode,
      itemName: optionalTextAt(row, journalColumns.name) ?? catalogItem.name,
      unit: optionalTextAt(row, journalColumns.unit),
      quantity,
      recipient: optionalTextAt(row, journalColumns.recipient),
      notes: optionalTextAt(row, journalColumns.notes),
      rowNumber
    });
  }

  const assignments: InventoryAssignmentInput[] = [];
  if (assignmentSheet) {
    const assignmentColumns = readColumns(assignmentSheet, {
      document: aliases.document,
      date: aliases.date,
      recipient: aliases.recipient,
      team: aliases.team,
      code: ["madungcu", "mavattu", "masanpham"],
      quantity: aliases.quantity,
      condition: aliases.condition,
      dueDate: aliases.dueDate,
      notes: aliases.notes
    }, ["document", "date", "recipient", "code", "quantity"]);
    for (let rowNumber = HEADER_ROW + 1; rowNumber <= assignmentSheet.rowCount; rowNumber += 1) {
      const row = assignmentSheet.getRow(rowNumber);
      if (isEmptyRow(row)) continue;
      const documentNumber = textAt(row, assignmentColumns.document);
      const itemCode = textAt(row, assignmentColumns.code);
      const statusText = normalizeHeader(optionalTextAt(row, assignmentColumns.condition) ?? "");
      if (!documentNumber && !itemCode) continue;
      const issuedAt = dateAt(row, assignmentColumns.date, `Cấp Phát Thợ!${rowNumber}`);
      const quantity = decimalAt(row, assignmentColumns.quantity, `Cấp Phát Thợ!${rowNumber}`);
      const recipient = textAt(row, assignmentColumns.recipient);
      if (!documentNumber || !itemCode || !issuedAt || !quantity || !recipient) {
        reportRows.push(`Cấp Phát Thợ dòng ${rowNumber}: thiếu mã phiếu, mã dụng cụ, ngày cấp, người nhận hoặc số lượng hợp lệ.`);
        continue;
      }
      if (!itemCodes.has(normalizeCode(itemCode))) {
        reportRows.push(`Cấp Phát Thợ dòng ${rowNumber}: mã dụng cụ ${itemCode} không có trong danh mục.`);
        continue;
      }
      assignments.push({
        documentNumber,
        issuedAt,
        recipient,
        team: optionalTextAt(row, assignmentColumns.team),
        itemCode,
        quantity,
        condition: optionalTextAt(row, assignmentColumns.condition),
        dueDate: dateAt(row, assignmentColumns.dueDate, `Cấp Phát Thợ!${rowNumber}`, true),
        notes: optionalTextAt(row, assignmentColumns.notes),
        status: /^(da thu hoi|da tra|da hoan tra|returned)$/.test(statusText) ? "returned" : "active",
        rowNumber
      });
    }
  }

  if (items.length > MAX_ITEMS) reportRows.push(`Danh Mục Vật Tư vượt quá ${MAX_ITEMS.toLocaleString("vi-VN")} dòng.`);
  if (movements.length > MAX_MOVEMENTS) reportRows.push(`Sổ Nhật Ký XNT vượt quá ${MAX_MOVEMENTS.toLocaleString("vi-VN")} dòng.`);
  if (assignments.length > MAX_ASSIGNMENTS) reportRows.push(`Cấp Phát Thợ vượt quá ${MAX_ASSIGNMENTS.toLocaleString("vi-VN")} dòng.`);
  if (reportRows.length) {
    throw new InventoryWorkbookError("Workbook có dữ liệu chưa hợp lệ; chưa có dòng nào được nhập.", reportRows.slice(0, 100));
  }
  if (!items.length && !movements.length && !assignments.length) {
    throw new InventoryWorkbookError("Workbook không có danh mục hoặc giao dịch kho để nhập.");
  }
  return { items, movements, assignments, lineCount: items.length + movements.length + assignments.length };
}

export async function createInventoryWorkbook(data: InventoryExportData): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "NovaBooks";
  workbook.created = new Date();
  const dashboard = workbook.addWorksheet("Tổng Quan (Dashboard)");
  dashboard.addRow(["NOVABOOKS · QUẢN LÝ KHO"]);
  dashboard.addRow(["Số liệu được xuất từ dữ liệu kho của tenant hiện tại."]);
  dashboard.addRow([]);
  dashboard.addRow(["Số mặt hàng", data.items.length, "Tổng tồn kho", data.items.reduce((sum, item) => sum + Number(item.currentQuantity), 0)]);
  dashboard.addRow(["Giao dịch kho", data.movements.length, "Dụng cụ đang cấp", data.assignments.filter((item) => item.status === "active").length]);
  dashboard.addRow([]);
  dashboard.addRow(["Mã vật tư", "Tên vật tư", "Tồn hiện tại", "Tồn tối thiểu", "Cảnh báo"]);
  for (const item of data.items.filter((entry) => Number(entry.currentQuantity) <= Number(entry.minimumQuantity))) {
    dashboard.addRow([item.code, item.name, Number(item.currentQuantity), Number(item.minimumQuantity), "CẦN NHẬP"]);
  }

  const journal = workbook.addWorksheet("Sổ Nhật Ký XNT");
  addSheetHeader(journal, "SỔ NHẬT KÝ NHẬP - XUẤT - TỒN", [
    "STT", "Ngày", "Mã Phiếu", "Loại Giao Dịch", "Mã Vật Tư", "Tên Vật Tư", "ĐVT", "Số Lượng", "Nơi Nhận", "Ghi Chú"
  ]);
  data.movements.forEach((movement, index) => journal.addRow([
    index + 1, movement.date, movement.documentNumber, movementTypeLabel(movement.type),
    movement.itemCode, movement.itemName, movement.unit, Number(movement.quantity),
    movement.recipient, movement.notes
  ]));

  const report = workbook.addWorksheet("Báo Cáo Tồn Kho");
  addSheetHeader(report, "BÁO CÁO TỒN KHO", [
    "STT", "Mã Vật Tư", "Tên Vật Tư", "Phân Loại", "Đơn Vị", "Tồn Đầu Kỳ", "Tổng Nhập",
    "Tổng Xuất", "Tồn Cuối", "Tồn Tối Thiểu", "Trạng Thái", "Vị Trí Kho", "Ghi Chú"
  ]);
  data.items.forEach((item, index) => report.addRow([
    index + 1, item.code, item.name, item.category, item.unit, Number(item.openingQuantity),
    Number(item.totalIncoming), Number(item.totalOutgoing), Number(item.currentQuantity),
    Number(item.minimumQuantity), item.status, item.location, item.notes
  ]));

  const catalog = workbook.addWorksheet("Danh Mục Vật Tư");
  addSheetHeader(catalog, "DANH MỤC VẬT TƯ", [
    "STT", "Mã Vật Tư", "Tên Vật Tư", "Phân Loại", "Đơn Vị", "Tồn Tối Thiểu", "Vị Trí Kho", "Ghi Chú"
  ]);
  data.items.forEach((item, index) => catalog.addRow([
    index + 1, item.code, item.name, item.category, item.unit, Number(item.minimumQuantity), item.location, item.notes
  ]));

  const assignments = workbook.addWorksheet("Cấp Phát Thợ");
  addSheetHeader(assignments, "THEO DÕI CẤP PHÁT DỤNG CỤ", [
    "STT", "Mã Phiếu", "Ngày Cấp", "Người Nhận", "Bộ Phận", "Mã Dụng Cụ", "Số Lượng",
    "Tình Trạng", "Hạn Thu Hồi", "Ghi Chú"
  ]);
  data.assignments.forEach((assignment, index) => assignments.addRow([
    index + 1, assignment.documentNumber, assignment.issuedAt, assignment.recipient,
    assignment.team, assignment.itemCode, Number(assignment.quantity),
    assignment.status === "returned" ? "Đã thu hồi" : assignment.condition ?? "Đang sử dụng",
    assignment.dueDate, assignment.notes
  ]));

  for (const sheet of workbook.worksheets) {
    sheet.views = [{ state: "frozen", ySplit: 4 }];
    sheet.columns.forEach((column) => { column.width = 18; });
    sheet.getRow(1).font = { bold: true, size: 15, color: { argb: "FF173A30" } };
    sheet.getRow(4).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF187B5A" } };
    sheet.autoFilter = { from: "A4", to: `${columnName(sheet.columnCount)}${Math.max(sheet.rowCount, 4)}` };
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function normalizeInventoryCode(value: string): string {
  return normalizeCode(value);
}

export function getMovementDirection(type: InventoryMovementType): 1 | -1 {
  return ["purchase_in", "return_in", "adjustment_in"].includes(type) ? 1 : -1;
}

function addSheetHeader(sheet: ExcelJS.Worksheet, title: string, headers: string[]): void {
  sheet.addRow([title]);
  sheet.addRow(["Không xóa hoặc sửa tiêu đề ở hàng 4; dữ liệu bắt đầu từ hàng 5."]);
  sheet.addRow([]);
  sheet.addRow(headers);
}

function findSheet(workbook: ExcelJS.Workbook, names: string[]): ExcelJS.Worksheet | undefined {
  const candidates = new Set(names.map(normalizeHeader));
  return workbook.worksheets.find((sheet) => candidates.has(normalizeHeader(sheet.name)));
}

function readColumns(
  sheet: ExcelJS.Worksheet,
  definitions: Record<string, readonly string[]>,
  required: string[]
): Record<string, number> {
  const headers = sheet.getRow(HEADER_ROW);
  const normalized = new Map<string, number>();
  headers.eachCell({ includeEmpty: false }, (cell, column) => {
    normalized.set(normalizeHeader(cellText(cell)), column);
  });
  const result: Record<string, number> = {};
  const missing: string[] = [];
  for (const [name, options] of Object.entries(definitions)) {
    const found = options.map(normalizeHeader).map((header) => normalized.get(header)).find((index) => index !== undefined);
    if (found !== undefined) result[name] = found;
    else if (required.includes(name)) missing.push(options[0] ?? name);
  }
  if (missing.length) {
    throw new InventoryWorkbookError(`Sheet "${sheet.name}" thiếu cột bắt buộc ở hàng ${HEADER_ROW}.`, missing);
  }
  return result;
}

function isEmptyRow(row: ExcelJS.Row): boolean {
  let hasValue = false;
  row.eachCell({ includeEmpty: false }, (cell) => {
    if (cell.value !== null && cell.value !== undefined && cell.value !== "") hasValue = true;
  });
  return !hasValue;
}

function isSummaryRow(row: ExcelJS.Row): boolean {
  let summary = false;
  row.eachCell({ includeEmpty: false }, (cell) => {
    if (typeof cell.value === "string" && normalizeHeader(cell.value).includes("tongcong")) summary = true;
  });
  return summary;
}

function textAt(row: ExcelJS.Row, column: number | undefined): string {
  return column ? cellText(row.getCell(column)).trim() : "";
}

function optionalTextAt(row: ExcelJS.Row, column: number | undefined): string | null {
  return textAt(row, column) || null;
}

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && !Array.isArray(value)) {
    if ("formula" in value || "sharedFormula" in value) {
      if ("result" in value && value.result !== null && value.result !== undefined) {
        return String(value.result);
      }
      throw new InventoryWorkbookError(
        "Không thể đọc ô công thức không có kết quả đã lưu; hãy mở và lưu workbook trong Excel trước khi nhập."
      );
    }
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join("");
    }
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("hyperlink" in value && typeof value.hyperlink === "string") return value.text ?? value.hyperlink;
  }
  return String(value);
}

function decimalAt(row: ExcelJS.Row, column: number | undefined, location: string): string | null {
  if (!column) return null;
  const raw = cellText(row.getCell(column)).trim();
  if (!raw) return null;
  const normalized = typeof row.getCell(column).value === "number"
    ? raw
    : raw.replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(?:\.\d{1,4})?$/.test(normalized)) {
    throw new InventoryWorkbookError("Workbook có số lượng không hợp lệ.", [`${location}: giá trị "${raw}" phải là số không âm, tối đa 4 chữ số thập phân.`]);
  }
  return normalized;
}

function dateAt(row: ExcelJS.Row, column: number | undefined, location: string, optional = false): string | null {
  if (!column) return null;
  const value = row.getCell(column).value;
  if ((value === null || value === undefined || value === "") && optional) return null;
  let date: string;
  if (value instanceof Date) {
    date = value.toISOString().slice(0, 10);
  } else {
    const raw = cellText(row.getCell(column)).trim();
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
    const local = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(raw);
    if (iso) date = `${iso[1]}-${iso[2]!.padStart(2, "0")}-${iso[3]!.padStart(2, "0")}`;
    else if (local) date = `${local[3]}-${local[2]!.padStart(2, "0")}-${local[1]!.padStart(2, "0")}`;
    else {
      if (optional && !raw) return null;
      if (optional && /^(khongthoihan|khongapdung|na|none)$/i.test(normalizeHeader(raw))) return null;
      throw new InventoryWorkbookError("Workbook có ngày không hợp lệ.", [`${location}: ngày phải theo YYYY-MM-DD hoặc DD/MM/YYYY.`]);
    }
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new InventoryWorkbookError("Workbook có ngày không hợp lệ.", [`${location}: ${date} không phải ngày hợp lệ.`]);
  }
  return date;
}

function parseMovementType(value: string): InventoryMovementType | null {
  const normalized = normalizeHeader(value);
  for (const [pattern, type] of movementNames) {
    if (pattern.test(normalized)) return type;
  }
  return null;
}

function movementTypeLabel(type: InventoryMovementType): string {
  return ({
    purchase_in: "Nhập mua",
    production_out: "Xuất sản xuất",
    issue_out: "Cấp phát thợ",
    return_in: "Thu hồi",
    adjustment_in: "Điều chỉnh tăng",
    adjustment_out: "Điều chỉnh giảm"
  })[type];
}

function normalizeCode(value: string): string {
  return value.trim().toLocaleLowerCase("vi-VN");
}

function normalizeHeader(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d").toLocaleLowerCase("vi-VN").replace(/[^a-z0-9]/g, "");
}

function columnName(column: number): string {
  let remaining = column;
  let name = "";
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return name;
}
