import type { DayOfWeek } from "@prisma/client";
import { timeToMinutes } from "@/lib/timetable-conflicts";

// Leave hours are computed from the ACTUAL durations of the timetable
// sessions a leave notice covers, then SNAPSHOT onto the entry at logging
// time — never recomputed later, so a shift/session time edit can't
// retroactively rewrite a historical leave record. A session's duration
// is its own `startTime`/`endTime` span (the same "HH:MM" wall-clock
// strings every other timetable feature uses); `TimetableSlot` has no FK
// to `Shift`, and a slot's stored times ARE its real length whether they
// came from a shift preset or were typed by hand.

/** Duration of one scheduled session in hours, e.g. 1.5. Never negative. */
export function sessionDurationHours(startTime: string, endTime: string): number {
  const mins = timeToMinutes(endTime) - timeToMinutes(startTime);
  return mins > 0 ? mins / 60 : 0;
}

/**
 * Sum of every linked session's own duration, rounded to 2dp so float
 * dust never shows (1.5 + 1.5 -> 3, not 2.9999999).
 */
export function sumSessionHours(
  sessions: { startTime: string; endTime: string }[]
): number {
  const total = sessions.reduce(
    (acc, s) => acc + sessionDurationHours(s.startTime, s.endTime),
    0
  );
  return Math.round(total * 100) / 100;
}

/** "12.5 hours", "1 hour", "0 hours" — a human label for a leave total. */
export function formatLeaveHours(hours: number): string {
  const n = Math.round(hours * 100) / 100;
  return `${n} ${n === 1 ? "hour" : "hours"}`;
}

// JS Date day index is 0=Sun..6=Sat; the schema's DayOfWeek enum is named,
// so map through this Sun-indexed list. Uses getUTCDay on a date-only
// "YYYY-MM-DD" string so the weekday is deterministic regardless of the
// server's timezone (the string has no time/zone component).
const DOW_BY_JS_INDEX: DayOfWeek[] = [
  "SUN",
  "MON",
  "TUE",
  "WED",
  "THU",
  "FRI",
  "SAT",
];

export function dayOfWeekFromISODate(dateStr: string): DayOfWeek | null {
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return DOW_BY_JS_INDEX[d.getUTCDay()];
}
