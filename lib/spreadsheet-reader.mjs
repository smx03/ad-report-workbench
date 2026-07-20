import ExcelJS from "exceljs";

export async function readWorkbookRows(input) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(toBuffer(input));
  const sheet = workbook.worksheets[0];
  if (!sheet) return { sheetName: "", headers: [], rows: [] };

  const columnCount = sheet.actualColumnCount;
  const headers = Array.from({ length: columnCount }, (_, index) => cleanHeader(sheet.getCell(1, index + 1).text));
  const rows = [];
  for (let rowIndex = 2; rowIndex <= sheet.actualRowCount; rowIndex += 1) {
    const record = {};
    headers.forEach((header, index) => {
      if (!header) return;
      const cell = sheet.getCell(rowIndex, index + 1);
      record[header] = cellValue(cell, header);
    });
    if (Object.values(record).some((value) => String(value ?? "").trim() !== "")) rows.push(record);
  }
  return { sheetName: sheet.name, headers, rows };
}

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError("Unsupported workbook input");
}

function cellValue(cell, header) {
  if (header === "账户id") return cell.text.trim();
  const value = cell.value;
  if (value && typeof value === "object") {
    if ("result" in value) return value.result ?? "";
    if ("richText" in value) return value.richText.map((item) => item.text).join("");
    if ("text" in value) return value.text;
  }
  return value ?? "";
}

function cleanHeader(value) {
  return String(value ?? "").trim();
}
