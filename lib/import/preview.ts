import type { ImportPreviewResult, ImportRowResult, ImportRowStatus } from "./types";

export interface RowValidation<T> {
  rowNumber: number;
  display: Record<string, string>;
  // null means the row already failed local validation (see `error`) and
  // has no dedup key to check.
  key: string | null;
  error: string | null;
  data: T | null;
}

// Turns per-row local validation results into the final preview: flags
// every row sharing a key 2+ times in the file as DUPLICATE_IN_FILE (not
// just the 2nd+ occurrence, since there's no safe way to guess which one
// is authoritative), then checks the remainder against what already
// exists in the DB.
export function buildPreview<T>(
  validations: RowValidation<T>[],
  existingKeys: Set<string>
): ImportPreviewResult<T> {
  const keyCounts = new Map<string, number>();
  for (const v of validations) {
    if (v.key === null) continue;
    keyCounts.set(v.key, (keyCounts.get(v.key) ?? 0) + 1);
  }

  const rows: ImportRowResult<T>[] = validations.map((v) => {
    if (v.error || v.key === null) {
      return {
        rowNumber: v.rowNumber,
        status: "ERROR" as ImportRowStatus,
        reason: v.error ?? "Invalid row",
        display: v.display,
        data: null,
      };
    }
    if ((keyCounts.get(v.key) ?? 0) > 1) {
      return {
        rowNumber: v.rowNumber,
        status: "DUPLICATE_IN_FILE" as ImportRowStatus,
        reason: "Same key appears more than once in this file",
        display: v.display,
        data: null,
      };
    }
    if (existingKeys.has(v.key)) {
      return {
        rowNumber: v.rowNumber,
        status: "ALREADY_EXISTS" as ImportRowStatus,
        reason: "Already exists — will be skipped",
        display: v.display,
        data: null,
      };
    }
    return {
      rowNumber: v.rowNumber,
      status: "OK" as ImportRowStatus,
      reason: null,
      display: v.display,
      data: v.data,
    };
  });

  return {
    rows,
    counts: {
      ok: rows.filter((r) => r.status === "OK").length,
      duplicate: rows.filter((r) => r.status === "DUPLICATE_IN_FILE").length,
      alreadyExists: rows.filter((r) => r.status === "ALREADY_EXISTS").length,
      error: rows.filter((r) => r.status === "ERROR").length,
    },
  };
}
