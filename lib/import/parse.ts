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

// A bare digit string (e.g. a phone number typed as a plain number, not
// Text) that Excel's default "General" cell format renders in scientific
// notation once it's long enough — e.g. "2.52634E+11" instead of
// "252634001234". SheetJS's raw:false mode (below) mirrors that same
// display formatting, so a cell like this silently loses precision unless
// we recover it from the cell's actual stored value instead. This is a
// real, previously-unhandled cause of "valid" digit-only phone numbers
// (and any other long numeric-ID-shaped column) failing validation after
// a bulk-import upload — see bulk-import-actions.ts's phone_number check.
const SCIENTIFIC_NOTATION_PATTERN = /^-?\d+(\.\d+)?E[+-]\d+$/i;

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
  // raw:false (formatted display text) is what every other cell type in
  // this app's templates relies on — dates, percentages, etc. read
  // exactly as a human would see them in Excel. raw:true (the cell's
  // actual stored value, full precision, never display-truncated) is
  // fetched alongside it purely as a fallback for the scientific-notation
  // case above; it's never used for anything else, so no other column's
  // existing behavior changes.
  const json = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: "",
  }) as unknown[][];
  if (json.length === 0) return { rows: [] };
  const rawJson = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: "",
  }) as unknown[][];

  const headers = (json[0] as unknown[]).map((h) =>
    String(h ?? "").trim().toLowerCase()
  );

  const rows: ParsedRow[] = [];
  for (let i = 1; i < json.length; i++) {
    const formattedRow = json[i] as unknown[];
    const rawRow = (rawJson[i] ?? []) as unknown[];
    const isBlank = formattedRow.every((c) => String(c ?? "").trim() === "");
    if (isBlank) continue;

    const cells: Record<string, string> = {};
    headers.forEach((header, idx) => {
      if (!header) return;
      const formatted = String(formattedRow[idx] ?? "").trim();
      if (SCIENTIFIC_NOTATION_PATTERN.test(formatted)) {
        const rawValue = rawRow[idx];
        if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
          cells[header] = String(rawValue);
          return;
        }
      }
      cells[header] = formatted;
    });
    rows.push({ rowNumber: i, cells });
  }
  return { rows };
}
