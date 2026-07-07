import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import {
  parseSpreadsheet,
  assertFileSize,
  assertRowCount,
  MAX_FILE_SIZE_BYTES,
  MAX_ROWS,
} from "./parse";

function bufferFromRows(rows: unknown[][]): ArrayBuffer {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Sheet1");
  const buf = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe("parseSpreadsheet", () => {
  it("lowercases headers and trims cell values", () => {
    const buf = bufferFromRows([
      ["Student_No", "Full Name"],
      [" S1001 ", "Jane Doe"],
    ]);

    const { rows } = parseSpreadsheet(buf);

    expect(rows).toEqual([
      { rowNumber: 1, cells: { student_no: "S1001", "full name": "Jane Doe" } },
    ]);
  });

  it("skips fully blank rows", () => {
    const buf = bufferFromRows([
      ["student_no", "full_name"],
      ["S1001", "Jane Doe"],
      ["", ""],
      ["S1002", "John Roe"],
    ]);

    const { rows } = parseSpreadsheet(buf);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.cells.student_no)).toEqual(["S1001", "S1002"]);
  });

  it("returns an empty row list for a header-only file", () => {
    const buf = bufferFromRows([["student_no", "full_name"]]);

    const { rows } = parseSpreadsheet(buf);

    expect(rows).toEqual([]);
  });

  it("throws UNREADABLE_FILE for a corrupt file that looks like a zip but isn't", () => {
    // SheetJS is lenient with plain text (it's parsed as a one-cell CSV), so
    // to actually trigger a parse failure the input needs to look like an
    // xlsx (zip) container and then fail to parse as one.
    const buf = new TextEncoder().encode("PK\x03\x04 not a real zip").buffer;

    expect(() => parseSpreadsheet(buf as ArrayBuffer)).toThrow("UNREADABLE_FILE");
  });
});

describe("assertFileSize / assertRowCount", () => {
  it("accepts sizes and counts within the limit", () => {
    expect(() => assertFileSize(MAX_FILE_SIZE_BYTES)).not.toThrow();
    expect(() => assertRowCount(MAX_ROWS)).not.toThrow();
  });

  it("rejects a file over the size limit", () => {
    expect(() => assertFileSize(MAX_FILE_SIZE_BYTES + 1)).toThrow("FILE_TOO_LARGE");
  });

  it("rejects a file over the row limit", () => {
    expect(() => assertRowCount(MAX_ROWS + 1)).toThrow("TOO_MANY_ROWS");
  });
});
