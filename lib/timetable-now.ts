import type { DayOfWeek } from "@prisma/client";
import { timeToMinutes } from "@/lib/timetable-conflicts";

// ── Campus timezone ──────────────────────────────────────────────────────
// TimetableSlot.startTime/endTime are plain "HH:MM" CAMPUS wall-clock
// strings (see CLAUDE.md — no per-session timezone anywhere). "Now" must
// therefore be read in the CAMPUS timezone, NOT the raw server clock: the
// app runs on Vercel/Neon (UTC) while the institution is EAT (UTC+3), so a
// naive `new Date().getHours()` is 3 hours behind campus wall-clock and,
// on a Saturday-morning campus time before ~03:00, `getDay()` still says
// Friday — which is the exact "Nearest upcoming — Saturday" bug this
// resolves at the root. Default `Africa/Mogadishu` (EAT, no DST);
// overridable per deployment via CAMPUS_TIMEZONE.
export const CAMPUS_TIME_ZONE =
  (typeof process !== "undefined" && process.env.CAMPUS_TIMEZONE?.trim()) || "Africa/Mogadishu";

const WEEKDAY_TO_ENUM: Record<string, DayOfWeek> = {
  Sun: "SUN",
  Mon: "MON",
  Tue: "TUE",
  Wed: "WED",
  Thu: "THU",
  Fri: "FRI",
  Sat: "SAT",
};

// The current day-of-week + "HH:MM" wall-clock, resolved in the CAMPUS
// timezone (not the server's own). `now` is injectable for tests; so is
// `timeZone` (tests pass "UTC" so a Date built in the runner's own zone
// isn't reinterpreted).
export function getCurrentDayAndTime(
  now: Date = new Date(),
  timeZone: string = CAMPUS_TIME_ZONE
): { day: DayOfWeek; time: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";

  const day = WEEKDAY_TO_ENUM[get("weekday")] ?? "SAT";
  // hourCycle "h23" yields 00–23, but some ICU builds still emit "24" at
  // midnight — normalise it.
  const rawHour = get("hour");
  const hh = (rawHour === "24" ? "00" : rawHour).padStart(2, "0");
  const mm = get("minute").padStart(2, "0");
  return { day, time: `${hh}:${mm}` };
}

interface TimedSlot {
  dayOfWeek: DayOfWeek;
  startTime: string;
  endTime: string;
}

export interface NowClassification<T extends TimedSlot> {
  // The day being shown — ALWAYS today. "Now" never jumps to a future day
  // (that was the old, deliberately-removed "fall forward up to a week"
  // behaviour). If today has nothing left, `inProgress`/`next` are both
  // empty and the caller shows a "Nothing else scheduled today" state.
  day: DayOfWeek;
  // Campus "HH:MM" now — exposed for the header line ("Saturday · 13:07").
  time: string;
  // start <= now < end (half-open — a session ending exactly now reads as
  // just-finished, not current). A session that hasn't started yet, even by
  // a minute, is NOT here — it's in `next`.
  inProgress: T[];
  // Later TODAY, soonest first. Never a future day.
  next: T[];
  // Already over today (end <= now), soonest first. The admin/dean "Now"
  // view ignores this; the dashboard widgets show it faded with an "Ended"
  // badge (they don't hide the day's history).
  ended: T[];
}

const byStart = (a: TimedSlot, b: TimedSlot) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime);

// Splits `candidates` (already scoped to the right semester + any
// class/lecturer/room/campus filter; day is NOT pre-filtered) into
// ended / in-progress / next-today buckets for the CURRENT campus time.
// STRICTLY today only — no cross-day fallback.
export function classifyForNow<T extends TimedSlot>(
  candidates: T[],
  now: Date = new Date(),
  timeZone: string = CAMPUS_TIME_ZONE
): NowClassification<T> {
  const { day: today, time } = getCurrentDayAndTime(now, timeZone);
  const nowMin = timeToMinutes(time);
  const todaySlots = candidates.filter((s) => s.dayOfWeek === today);

  return {
    day: today,
    time,
    inProgress: todaySlots
      .filter((s) => timeToMinutes(s.startTime) <= nowMin && nowMin < timeToMinutes(s.endTime))
      .sort(byStart),
    next: todaySlots.filter((s) => timeToMinutes(s.startTime) > nowMin).sort(byStart),
    ended: todaySlots.filter((s) => timeToMinutes(s.endTime) <= nowMin).sort(byStart),
  };
}

// ── Today's-schedule widget (Lecturer & Student dashboards) ──────────────
export type TodaySessionState = "ended" | "in_progress" | "upcoming";

export interface TodayScheduleInput extends TimedSlot {
  id: string;
  courseName: string;
  className: string;
  roomLabel: string; // "Room — Campus", or "" when no room
}

export interface TodayScheduleItem extends TodayScheduleInput {
  state: TodaySessionState;
}

export interface TodaySchedule {
  day: DayOfWeek;
  time: string; // campus "HH:MM" as of this build — for an "as of …" line
  items: TodayScheduleItem[]; // ALL of today's sessions, chronological (by start time)
}

// Every session today, tagged with its live state and ordered
// chronologically by start time (which IS correct shift order — Morning
// Session 1 < Session 2 < … < Afternoon Session 1, since startTime is a
// zero-padded 24h string). Ended sessions stay in the list (faded +
// "Ended" in the UI), never dropped.
export function buildTodaySchedule(
  slots: TodayScheduleInput[],
  now: Date = new Date(),
  timeZone: string = CAMPUS_TIME_ZONE
): TodaySchedule {
  const c = classifyForNow(slots, now, timeZone);
  const tag = (arr: TodayScheduleInput[], state: TodaySessionState): TodayScheduleItem[] =>
    arr.map((s) => ({ ...s, state }));

  const items = [
    ...tag(c.ended, "ended"),
    ...tag(c.inProgress, "in_progress"),
    ...tag(c.next, "upcoming"),
  ].sort(
    (a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime) || a.courseName.localeCompare(b.courseName)
  );

  return { day: c.day, time: c.time, items };
}

interface ShiftRange {
  startTime: string;
  endTime: string;
}

// A session "belongs" to a shift-based quick filter if its start time
// falls inside ANY ONE matching range's own [start, end) window —
// deliberately NOT a single min-to-max span across multiple ranges, so a
// gap between two non-contiguous ranges (e.g. 08:00-10:00 and
// 10:30-12:00) is never wrongly treated as a match.
export function matchesAnyShiftRange<T extends ShiftRange>(startTime: string, ranges: T[]): boolean {
  const t = timeToMinutes(startTime);
  return ranges.some((r) => t >= timeToMinutes(r.startTime) && t < timeToMinutes(r.endTime));
}
