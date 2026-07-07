import { describe, it, expect } from "vitest";
import { buildPreview, type RowValidation } from "./preview";

describe("buildPreview", () => {
  it("marks a row with a local error as ERROR regardless of key", () => {
    const validations: RowValidation<{ v: string }>[] = [
      { rowNumber: 1, display: {}, key: null, error: "Missing x", data: null },
    ];

    const result = buildPreview(validations, new Set());

    expect(result.rows[0].status).toBe("ERROR");
    expect(result.counts).toEqual({ ok: 0, duplicate: 0, alreadyExists: 0, error: 1 });
  });

  it("flags every row sharing a key as DUPLICATE_IN_FILE, not just the 2nd+", () => {
    const validations: RowValidation<{ v: string }>[] = [
      { rowNumber: 1, display: {}, key: "a", error: null, data: { v: "1" } },
      { rowNumber: 2, display: {}, key: "a", error: null, data: { v: "2" } },
      { rowNumber: 3, display: {}, key: "a", error: null, data: { v: "3" } },
    ];

    const result = buildPreview(validations, new Set());

    expect(result.rows.map((r) => r.status)).toEqual([
      "DUPLICATE_IN_FILE",
      "DUPLICATE_IN_FILE",
      "DUPLICATE_IN_FILE",
    ]);
    expect(result.counts.duplicate).toBe(3);
  });

  it("marks a unique key already in the DB as ALREADY_EXISTS", () => {
    const validations: RowValidation<{ v: string }>[] = [
      { rowNumber: 1, display: {}, key: "a", error: null, data: { v: "1" } },
    ];

    const result = buildPreview(validations, new Set(["a"]));

    expect(result.rows[0].status).toBe("ALREADY_EXISTS");
  });

  it("marks a unique, new key as OK and carries its data through", () => {
    const validations: RowValidation<{ v: string }>[] = [
      { rowNumber: 1, display: {}, key: "a", error: null, data: { v: "1" } },
    ];

    const result = buildPreview(validations, new Set());

    expect(result.rows[0]).toMatchObject({ status: "OK", data: { v: "1" } });
  });

  it("makes re-uploading the same already-imported file a no-op preview (idempotency)", () => {
    const validations: RowValidation<{ v: string }>[] = [
      { rowNumber: 1, display: {}, key: "a", error: null, data: { v: "1" } },
      { rowNumber: 2, display: {}, key: "b", error: null, data: { v: "2" } },
    ];

    const result = buildPreview(validations, new Set(["a", "b"]));

    expect(result.counts.ok).toBe(0);
    expect(result.counts.alreadyExists).toBe(2);
  });
});
