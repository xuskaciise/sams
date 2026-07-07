import * as XLSX from "xlsx";

export interface TemplateColumn {
  header: string;
  example1: string;
  example2: string;
}

// Builds an .xlsx template with the exact expected headers and 2 example
// rows, returned as base64 so it can cross the Server Action boundary as
// plain JSON and be turned into a Blob client-side.
export function buildTemplateBase64(
  columns: TemplateColumn[],
  sheetName = "Template"
): string {
  const headerRow = columns.map((c) => c.header);
  const exampleRow1 = columns.map((c) => c.example1);
  const exampleRow2 = columns.map((c) => c.example2);

  const sheet = XLSX.utils.aoa_to_sheet([headerRow, exampleRow1, exampleRow2]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  return Buffer.from(buffer).toString("base64");
}
