import { describe, it, expect } from "vitest";
import { getCurrentDayAndTime, classifyForNow, matchesAnyShiftRange } from "./timetable-now";

// 2026-07-25 = Saturday, 26 = Sunday, 27 = Monday, 29 = Wednesday,
// 30 = Thursday, 31 = Friday, Aug 1 = Saturday (wraps the week).
const SAT_10_30 = new Date(2026, 6, 25, 10, 30);
const MON_09_00 = new Date(2026, 6, 27, 9, 0);
const WED_23_59 = new Date(2026, 6, 29, 23, 59);
const FRI_08_00 = new Date(2026, 6, 31, 8, 0);

describe("getCurrentDayAndTime", () => {
  it("maps JS getDay() to this app's Sat-first DayOfWeek enum", () => {
    expect(getCurrentDayAndTime(SAT_10_30)).toEqual({ day: "SAT", time: "10:30" });
    expect(getCurrentDayAndTime(MON_09_00)).toEqual({ day: "MON", time: "09:00" });
  });

  it("zero-pads single-digit hours/minutes", () => {
    expect(getCurrentDayAndTime(new Date(2026, 6, 25, 7, 5))).toEqual({
      day: "SAT",
      time: "07:05",
    });
  });
});

interface T {
  id: string;
  dayOfWeek: "SAT" | "SUN" | "MON" | "TUE" | "WED" | "THU" | "FRI";
  startTime: string;
  endTime: string;
}

describe("classifyForNow", () => {
  it("a session covering the current time is in progress", () => {
    const slots: T[] = [{ id: "1", dayOfWeek: "MON", startTime: "08:00", endTime: "10:00" }];
    const result = classifyForNow(slots, MON_09_00);
    expect(result).toEqual({ day: "MON", isFallbackDay: false, inProgress: slots, next: [] });
  });

  it("a session ending exactly at the current time is NOT in progress (half-open)", () => {
    const slots: T[] = [{ id: "1", dayOfWeek: "MON", startTime: "07:00", endTime: "09:00" }];
    const result = classifyForNow(slots, MON_09_00);
    expect(result.inProgress).toEqual([]);
  });

  it("a session starting exactly at the current time IS in progress", () => {
    const slots: T[] = [{ id: "1", dayOfWeek: "MON", startTime: "09:00", endTime: "10:00" }];
    const result = classifyForNow(slots, MON_09_00);
    expect(result.inProgress).toEqual(slots);
  });

  it("later-today sessions are 'next', soonest first, regardless of input order", () => {
    const later = { id: "later", dayOfWeek: "MON" as const, startTime: "14:00", endTime: "15:00" };
    const soonest = { id: "soonest", dayOfWeek: "MON" as const, startTime: "11:00", endTime: "12:00" };
    const result = classifyForNow([later, soonest], MON_09_00);
    expect(result.next.map((s) => s.id)).toEqual(["soonest", "later"]);
  });

  it("a session earlier today that already ended is excluded from today's buckets", () => {
    const passed = { id: "passed", dayOfWeek: "MON" as const, startTime: "06:00", endTime: "07:00" };
    const later = { id: "later", dayOfWeek: "MON" as const, startTime: "11:00", endTime: "12:00" };
    // `later` keeps today non-empty so the assertion is purely about
    // `passed` being excluded, not entangled with the forward-fallback path.
    const result = classifyForNow([passed, later], MON_09_00);
    expect(result).toEqual({ day: "MON", isFallbackDay: false, inProgress: [], next: [later] });
  });

  it("ignores sessions on other days when today has something", () => {
    const today = { id: "today", dayOfWeek: "MON" as const, startTime: "11:00", endTime: "12:00" };
    const otherDay = { id: "other", dayOfWeek: "TUE" as const, startTime: "08:00", endTime: "09:00" };
    const result = classifyForNow([today, otherDay], MON_09_00);
    expect(result.next).toEqual([today]);
  });

  it("falls forward to the nearest future day when today has nothing", () => {
    // Wednesday, late — nothing left today (WED has no PT sessions here);
    // the next thing is Friday.
    const friSession: T = { id: "fri", dayOfWeek: "FRI", startTime: "08:00", endTime: "10:00" };
    const result = classifyForNow([friSession], WED_23_59);
    expect(result).toEqual({ day: "FRI", isFallbackDay: true, inProgress: [], next: [friSession] });
  });

  it("forward fallback wraps the week (Friday -> next Saturday)", () => {
    const satSession: T = { id: "sat", dayOfWeek: "SAT", startTime: "08:00", endTime: "10:00" };
    const result = classifyForNow([satSession], FRI_08_00 /* after the 08:00 session already started/ended is irrelevant, FRI has none in candidates */);
    expect(result.day).toBe("SAT");
    expect(result.isFallbackDay).toBe(true);
    expect(result.next).toEqual([satSession]);
  });

  it("prefers a sooner day within the week over wrapping to next week", () => {
    // From Wednesday, a Thursday session (2 days out) must win over a
    // Monday-only session, even though wrapping to "next Monday" (offset 7)
    // would technically also be a valid future occurrence.
    const thu: T = { id: "thu", dayOfWeek: "THU", startTime: "08:00", endTime: "10:00" };
    const mon: T = { id: "mon", dayOfWeek: "MON", startTime: "08:00", endTime: "10:00" };
    const result = classifyForNow([thu, mon], WED_23_59);
    expect(result).toEqual({ day: "THU", isFallbackDay: true, inProgress: [], next: [thu] });
  });

  it("a day-only-elsewhere-in-the-week session wraps to its NEXT occurrence, not treated as already past", () => {
    // TimetableSlot has no real date, only a recurring weekday — a
    // Monday-only class viewed from Wednesday has no sooner occurrence
    // than next Monday, so wrapping all the way to offset 7 is correct,
    // not a backward reach.
    const monSession: T = { id: "mon", dayOfWeek: "MON", startTime: "08:00", endTime: "10:00" };
    const result = classifyForNow([monSession], WED_23_59);
    expect(result).toEqual({ day: "MON", isFallbackDay: true, inProgress: [], next: [monSession] });
  });

  it("truly nothing within a week matching -> stays on today with empty buckets", () => {
    const result = classifyForNow([], MON_09_00);
    expect(result).toEqual({ day: "MON", isFallbackDay: false, inProgress: [], next: [] });
  });
});

describe("matchesAnyShiftRange", () => {
  const ranges = [
    { startTime: "08:00", endTime: "10:00" },
    { startTime: "10:30", endTime: "12:00" },
  ];

  it("matches a start time inside the first range", () => {
    expect(matchesAnyShiftRange("09:00", ranges)).toBe(true);
  });

  it("matches a start time inside a later, non-contiguous range", () => {
    expect(matchesAnyShiftRange("11:00", ranges)).toBe(true);
  });

  it("does NOT match a start time in the gap between two non-contiguous ranges", () => {
    // This is the whole reason matching is per-range instead of one
    // collapsed min-to-max span — 10:15 falls between 10:00 and 10:30.
    expect(matchesAnyShiftRange("10:15", ranges)).toBe(false);
  });

  it("start time exactly at a range's end is not a match (half-open)", () => {
    expect(matchesAnyShiftRange("10:00", ranges)).toBe(false);
  });

  it("start time exactly at a range's start IS a match", () => {
    expect(matchesAnyShiftRange("10:30", ranges)).toBe(true);
  });

  it("no ranges at all never matches", () => {
    expect(matchesAnyShiftRange("09:00", [])).toBe(false);
  });
});
