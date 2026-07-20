export async function readWorkbookRows(input) {
  if (!globalThis.ExcelJS) throw new Error("Excel解析组件未加载，请刷新页面后重试。");
  const workbook = new globalThis.ExcelJS.Workbook();
  await workbook.xlsx.load(input);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { sheetName: "", headers: [], rows: [] };

  const columnCount = sheet.actualColumnCount;
  const headers = Array.from({ length: columnCount }, (_, index) => cleanHeader(sheet.getCell(1, index + 1).text));
  const rows = [];
  for (let rowIndex = 2; rowIndex <= sheet.actualRowCount; rowIndex += 1) {
    const record = {};
    headers.forEach((header, index) => {
      if (!header) return;
      record[header] = cellValue(sheet.getCell(rowIndex, index + 1), header);
    });
    if (Object.values(record).some((value) => String(value ?? "").trim() !== "")) rows.push(record);
  }
  return { sheetName: sheet.name, headers, rows };
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
