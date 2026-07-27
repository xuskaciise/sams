import { describe, it, expect } from "vitest";
import { generateRoomRange } from "./range-generator";

describe("generateRoomRange", () => {
  it("generates the documented example: prefix 'Room 1' + 01..20 -> Room 101..Room 120", () => {
    const result = generateRoomRange({ prefix: "Room 1", startText: "01", endText: "20" });
    if (!result.ok) throw new Error("expected ok result");
    expect(result.names).toHaveLength(20);
    expect(result.names[0]).toBe("Room 101");
    expect(result.names[19]).toBe("Room 120");
  });

  it("infers zero-padding width from the typed start number", () => {
    const result = generateRoomRange({ prefix: "Lab ", startText: "001", endText: "003" });
    if (!result.ok) throw new Error("expected ok result");
    expect(result.names).toEqual(["Lab 001", "Lab 002", "Lab 003"]);
  });

  it("does not pad when the start number has no leading zeros", () => {
    const result = generateRoomRange({ prefix: "Hall ", startText: "1", endText: "3" });
    if (!result.ok) throw new Error("expected ok result");
    expect(result.names).toEqual(["Hall 1", "Hall 2", "Hall 3"]);
  });

  it("a number naturally wider than the inferred padding is not truncated", () => {
    const result = generateRoomRange({ prefix: "Room ", startText: "08", endText: "11" });
    if (!result.ok) throw new Error("expected ok result");
    expect(result.names).toEqual(["Room 08", "Room 09", "Room 10", "Room 11"]);
  });

  it("rejects an empty prefix", () => {
    const result = generateRoomRange({ prefix: "  ", startText: "1", endText: "5" });
    expect(result.ok).toBe(false);
  });

  it("rejects non-numeric start/end", () => {
    expect(generateRoomRange({ prefix: "Room ", startText: "a", endText: "5" }).ok).toBe(false);
    expect(generateRoomRange({ prefix: "Room ", startText: "1", endText: "b" }).ok).toBe(false);
  });

  it("rejects start greater than end", () => {
    const result = generateRoomRange({ prefix: "Room ", startText: "10", endText: "5" });
    expect(result.ok).toBe(false);
  });

  it("rejects a range larger than the max size", () => {
    const result = generateRoomRange({ prefix: "Room ", startText: "1", endText: "1000" });
    expect(result.ok).toBe(false);
  });

  it("a single-number range (start === end) produces exactly one name", () => {
    const result = generateRoomRange({ prefix: "Room ", startText: "5", endText: "5" });
    if (!result.ok) throw new Error("expected ok result");
    expect(result.names).toEqual(["Room 5"]);
  });
});
