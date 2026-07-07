// Shared shapes for the bulk-import flow. Safe to import from client
// components — contains no server-only code.

export type ImportRowStatus =
  | "OK"
  | "DUPLICATE_IN_FILE"
  | "ALREADY_EXISTS"
  | "ERROR";

export interface ImportRowResult<T> {
  rowNumber: number;
  status: ImportRowStatus;
  reason: string | null;
  display: Record<string, string>;
  // Only present for OK rows — sent back verbatim to the confirm action.
  data: T | null;
}

export interface ImportPreviewResult<T> {
  rows: ImportRowResult<T>[];
  counts: {
    ok: number;
    duplicate: number;
    alreadyExists: number;
    error: number;
  };
}

export interface BulkImportColumn {
  key: string;
  label: string;
}
