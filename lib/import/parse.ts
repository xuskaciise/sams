import * as XLSX from "xlsx";

export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
export const MAX_ROWS = 2000;

export function assertFileSize(size: number): void {
  if (size > MAX_FILE_SIZE_BYTES) {
    throw new Error("FILE_TOO_LARGE");
  }
}

export function assertRowCount(count: number): void {
  if (count > MAX_ROWS) {
    throw new Error("TOO_MANY_ROWS");
  }
}

export interface ParsedRow {
  rowNumber: number; // 1-indexed, excluding the header row
  cells: Record<string, string>; // lowercased header -> trimmed cell value
}

// Reads .xlsx or .csv (SheetJS auto-detects the format) into rows keyed by
// lowercased header, so column matching is forgiving of header casing.
// Throws a plain Error the caller can translate into a user-facing message.
export function parseSpreadsheet(buffer: ArrayBuffer): { rows: ParsedRow[] } {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "array" });
  } catch {
    throw new Error("UNREADABLE_FILE");
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { rows: [] };
  const sheet = workbook.Sheets[sheetName];
  const json = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: "",
  }) as unknown[][];
  if (json.length === 0) return { rows: [] };

  const headers = (json[0] as unknown[]).map((h) =>
    String(h ?? "").trim().toLowerCase()
  );

  const rows: ParsedRow[] = [];
  for (let i = 1; i < json.length; i++) {
    const rawRow = json[i] as unknown[];
    const isBlank = rawRow.every((c) => String(c ?? "").trim() === "");
    if (isBlank) continue;

    const cells: Record<string, string> = {};
    headers.forEach((header, idx) => {
      if (!header) return;
      cells[header] = String(rawRow[idx] ?? "").trim();
    });
    rows.push({ rowNumber: i, cells });
  }
  return { rows };
}
