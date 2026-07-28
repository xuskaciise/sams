// Pure, DB-free — generates room names for the "Range" bulk-add mode
// (e.g. prefix "Room 1" + "01".."20" -> "Room 101".."Room 120"). The
// zero-padding width is inferred from how the admin typed the start
// number (a leading zero in "01" means "pad to 2 digits"), not a
// separate field — matches common spreadsheet-autofill UX. No server
// round-trip needed: this only produces candidate names, it never checks
// them against the DB (that's previewBulkRooms's job).
const MAX_RANGE_SIZE = 500;

export interface RoomRangeInput {
  prefix: string;
  startText: string;
  endText: string;
}

export type RoomRangeResult =
  | { ok: true; names: string[] }
  | { ok: false; error: string };

export function generateRoomRange(input: RoomRangeInput): RoomRangeResult {
  // Trailing whitespace in the prefix is significant (e.g. "Lab " + "001"
  // -> "Lab 001") — only leading/trailing-only blankness is rejected, the
  // prefix itself is used as typed.
  if (!input.prefix.trim()) return { ok: false, error: "Prefix is required" };
  const prefix = input.prefix;

  const startText = input.startText.trim();
  const endText = input.endText.trim();
  if (!/^\d+$/.test(startText) || !/^\d+$/.test(endText)) {
    return { ok: false, error: "Start and end must be whole numbers" };
  }

  const start = parseInt(startText, 10);
  const end = parseInt(endText, 10);
  if (start > end) {
    return { ok: false, error: "Start number must be less than or equal to end number" };
  }

  const count = end - start + 1;
  if (count > MAX_RANGE_SIZE) {
    return { ok: false, error: `Too many rooms at once (max ${MAX_RANGE_SIZE})` };
  }

  const width = startText.length;
  const names: string[] = [];
  for (let n = start; n <= end; n++) {
    names.push(`${prefix}${String(n).padStart(width, "0")}`);
  }
  return { ok: true, names };
}
