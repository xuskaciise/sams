import { describe, it, expect } from "vitest";
import {
  getCurrentDayAndTime,
  classifyForNow,
  buildTodaySchedule,
  matchesAnyShiftRange,
  type TodayScheduleInput,
} from "./timetable-now";

// All time-based tests pin timeZone: "UTC" and build dates with Date.UTC
// so they don't depend on the test runner's own zone. 2026-07-25 = Sat,
// 27 = Mon, 29 = Wed, 31 = Fri.
const SAT_10_30 = new Date(Date.UTC(2026, 6, 25, 10, 30));
const MON_09_00 = new Date(Date.UTC(2026, 6, 27, 9, 0));
const WED_23_59 = new Date(Date.UTC(2026, 6, 29, 23, 59));

describe("getCurrentDayAndTime", () => {
  it("maps the weekday to this app's Sat-first DayOfWeek enum, zero-padded HH:MM", () => {
    expect(getCurrentDayAndTime(SAT_10_30, "UTC")).toEqual({ day: "SAT", time: "10:30" });
    expect(getCurrentDayAndTime(MON_09_00, "UTC")).toEqual({ day: "MON", time: "09:00" });
    expect(getCurrentDayAndTime(new Date(Date.UTC(2026, 6, 25, 7, 5)), "UTC")).toEqual({
      day: "SAT",
      time: "07:05",
    });
  });

  it("resolves 'now' in the CAMPUS timezone, not the server's — the root-cause fix", () => {
    // Friday 23:30 UTC is Saturday 02:30 in Africa/Mogadishu (UTC+3). The
    // old server-clock logic would say FRI 23:30 and, finding nothing left
    // Friday, jump forward to "Nearest upcoming — Saturday".
    const fri_2330_utc = new Date(Date.UTC(2026, 6, 31, 23, 30));
    expect(getCurrentDayAndTime(fri_2330_utc, "Africa/Mogadishu")).toEqual({
      day: "SAT",
      time: "02:30",
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
    const r = classifyForNow(slots, MON_09_00, "UTC");
    expect(r).toEqual({ day: "MON", time: "09:00", inProgress: slots, next: [], ended: [] });
  });

  it("a session ending exactly at the current time is NOT in progress (half-open) — it's ended", () => {
    const slots: T[] = [{ id: "1", dayOfWeek: "MON", startTime: "07:00", endTime: "09:00" }];
    const r = classifyForNow(slots, MON_09_00, "UTC");
    expect(r.inProgress).toEqual([]);
    expect(r.ended).toEqual(slots);
  });

  it("a session starting exactly at the current time IS in progress", () => {
    const slots: T[] = [{ id: "1", dayOfWeek: "MON", startTime: "09:00", endTime: "10:00" }];
    const r = classifyForNow(slots, MON_09_00, "UTC");
    expect(r.inProgress).toEqual(slots);
  });

  it("a session starting in 1 minute is NOT in progress — it's in `next`", () => {
    const soon: T = { id: "soon", dayOfWeek: "MON", startTime: "09:01", endTime: "10:00" };
    const r = classifyForNow([soon], MON_09_00, "UTC");
    expect(r.inProgress).toEqual([]);
    expect(r.next).toEqual([soon]);
    expect(r.ended).toEqual([]);
  });

  it("a session that just ended (by a minute) is NOT in progress and NOT upcoming — only `ended`", () => {
    const justOver: T = { id: "over", dayOfWeek: "MON", startTime: "07:30", endTime: "08:59" };
    const r = classifyForNow([justOver], MON_09_00, "UTC");
    expect(r.inProgress).toEqual([]);
    expect(r.next).toEqual([]);
    expect(r.ended).toEqual([justOver]);
  });

  it("`next` is soonest-first regardless of input order; other days are ignored", () => {
    const later: T = { id: "later", dayOfWeek: "MON", startTime: "14:00", endTime: "15:00" };
    const soonest: T = { id: "soonest", dayOfWeek: "MON", startTime: "11:00", endTime: "12:00" };
    const otherDay: T = { id: "tue", dayOfWeek: "TUE", startTime: "08:00", endTime: "09:00" };
    const r = classifyForNow([later, soonest, otherDay], MON_09_00, "UTC");
    expect(r.next.map((s) => s.id)).toEqual(["soonest", "later"]);
  });

  it("NEVER jumps to a future day — today with nothing left stays on today with empty buckets", () => {
    // It's Wednesday 23:59. The only sessions are Friday's. The old logic
    // returned { day: "FRI", isFallbackDay: true, ... }. Now it must NOT.
    const fri: T = { id: "fri", dayOfWeek: "FRI", startTime: "08:00", endTime: "10:00" };
    const r = classifyForNow([fri], WED_23_59, "UTC");
    expect(r).toEqual({ day: "WED", time: "23:59", inProgress: [], next: [], ended: [] });
  });

  it("today's earlier sessions land in `ended` even when nothing is upcoming", () => {
    const morning: T = { id: "am", dayOfWeek: "MON", startTime: "06:00", endTime: "07:00" };
    const r = classifyForNow([morning], MON_09_00, "UTC");
    expect(r).toEqual({ day: "MON", time: "09:00", inProgress: [], next: [], ended: [morning] });
  });

  it("empty candidates -> today, all buckets empty", () => {
    expect(classifyForNow([], MON_09_00, "UTC")).toEqual({
      day: "MON",
      time: "09:00",
      inProgress: [],
      next: [],
      ended: [],
    });
  });
});

describe("buildTodaySchedule", () => {
  const mk = (
    id: string,
    dayOfWeek: TodayScheduleInput["dayOfWeek"],
    startTime: string,
    endTime: string,
    courseName = `C-${id}`
  ): TodayScheduleInput => ({
    id,
    dayOfWeek,
    startTime,
    endTime,
    courseName,
    className: "CMS26-A-FT",
    roomLabel: "R1 — Main",
  });

  it("returns every session today, chronological by start time, with live state tags — ended kept", () => {
    const slots = [
      mk("up", "MON", "13:00", "14:00"),
      mk("now", "MON", "08:30", "10:00"),
      mk("done", "MON", "06:00", "07:00"),
      mk("otherDay", "TUE", "08:00", "09:00"),
    ];
    const r = buildTodaySchedule(slots, MON_09_00, "UTC");
    expect(r.day).toBe("MON");
    expect(r.time).toBe("09:00");
    expect(r.items.map((s) => [s.id, s.state])).toEqual([
      ["done", "ended"],
      ["now", "in_progress"],
      ["up", "upcoming"],
    ]);
  });

  it("ties on start time break by course name", () => {
    const slots = [
      mk("b", "MON", "11:00", "12:00", "Zoology"),
      mk("a", "MON", "11:00", "12:00", "Anatomy"),
    ];
    const r = buildTodaySchedule(slots, MON_09_00, "UTC");
    expect(r.items.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("no sessions today -> empty items, still reports today", () => {
    const r = buildTodaySchedule([mk("x", "FRI", "08:00", "10:00")], MON_09_00, "UTC");
    expect(r).toEqual({ day: "MON", time: "09:00", items: [] });
  });
});

describe("matchesAnyShiftRange", () => {
  const ranges = [
    { startTime: "08:00", endTime: "10:00" },
    { startTime: "10:30", endTime: "12:00" },
  ];

  it("matches inside a range, not in the gap, half-open at the edges", () => {
    expect(matchesAnyShiftRange("09:00", ranges)).toBe(true);
    expect(matchesAnyShiftRange("11:00", ranges)).toBe(true);
    expect(matchesAnyShiftRange("10:15", ranges)).toBe(false);
    expect(matchesAnyShiftRange("10:00", ranges)).toBe(false);
    expect(matchesAnyShiftRange("10:30", ranges)).toBe(true);
    expect(matchesAnyShiftRange("09:00", [])).toBe(false);
  });
});
