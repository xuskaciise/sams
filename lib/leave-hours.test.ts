import { describe, it, expect } from "vitest";
import {
  sessionDurationHours,
  sumSessionHours,
  formatLeaveHours,
  dayOfWeekFromISODate,
} from "./leave-hours";

describe("sessionDurationHours", () => {
  it("computes the span between two HH:MM times in hours", () => {
    expect(sessionDurationHours("09:00", "10:30")).toBe(1.5);
    expect(sessionDurationHours("11:00", "13:30")).toBe(2.5);
    expect(sessionDurationHours("08:00", "12:00")).toBe(4);
  });

  it("is never negative — a zero or inverted range is 0", () => {
    expect(sessionDurationHours("10:00", "10:00")).toBe(0);
    expect(sessionDurationHours("12:00", "09:00")).toBe(0);
  });
});

describe("sumSessionHours", () => {
  it("sums each session's own duration and rounds float dust away", () => {
    expect(
      sumSessionHours([
        { startTime: "09:00", endTime: "10:30" },
        { startTime: "11:00", endTime: "13:30" },
      ])
    ).toBe(4);
  });

  it("handles many 1.5h sessions without float drift", () => {
    const s = { startTime: "09:00", endTime: "10:30" };
    expect(sumSessionHours([s, s, s, s, s])).toBe(7.5);
  });

  it("is 0 for an empty selection", () => {
    expect(sumSessionHours([])).toBe(0);
  });
});

describe("formatLeaveHours", () => {
  it("pluralizes correctly", () => {
    expect(formatLeaveHours(1)).toBe("1 hour");
    expect(formatLeaveHours(0)).toBe("0 hours");
    expect(formatLeaveHours(12.5)).toBe("12.5 hours");
  });
});

describe("dayOfWeekFromISODate", () => {
  it("maps a YYYY-MM-DD string to the schema DayOfWeek enum (UTC, tz-independent)", () => {
    expect(dayOfWeekFromISODate("2026-08-31")).toBe("MON");
    expect(dayOfWeekFromISODate("2026-08-30")).toBe("SUN");
    expect(dayOfWeekFromISODate("2026-08-29")).toBe("SAT");
  });

  it("tolerates a full ISO datetime string", () => {
    expect(dayOfWeekFromISODate("2026-08-31T14:22:00.000Z")).toBe("MON");
  });

  it("returns null for an unparseable value", () => {
    expect(dayOfWeekFromISODate("not-a-date")).toBeNull();
    expect(dayOfWeekFromISODate("")).toBeNull();
  });
});
