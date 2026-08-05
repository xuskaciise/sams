import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { nullableDecimalToNumber } from "./serialize";

describe("nullableDecimalToNumber", () => {
  it("returns null for null", () => {
    expect(nullableDecimalToNumber(null)).toBeNull();
  });

  it("converts a Decimal to a plain number", () => {
    expect(nullableDecimalToNumber(new Prisma.Decimal("3"))).toBe(3);
  });

  it("preserves fractional precision (2.5 stays 2.5, not 2 or 2.50000001)", () => {
    expect(nullableDecimalToNumber(new Prisma.Decimal("2.5"))).toBe(2.5);
  });

  it("returns a plain number, not a Decimal instance", () => {
    const result = nullableDecimalToNumber(new Prisma.Decimal("1.5"));
    expect(typeof result).toBe("number");
  });
});
