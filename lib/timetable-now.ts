import type { DayOfWeek } from "@prisma/client";
import { timeToMinutes } from "@/lib/timetable-conflicts";
import { ALL_DAYS_ORDER } from "@/lib/timetable-days";

// This app has no per-user/institution timezone setting anywhere else
// (see CLAUDE.md: startTime/endTime are plain "HH:MM" wall-clock strings,
// not UTC-anchored) — "now" is read off the server's own local clock,
// same simplicity as everywhere else in the codebase.
export function getCurrentDayAndTime(now: Date = new Date()): {
  day: DayOfWeek;
  time: string;
} {
  // JS getDay(): 0=Sun..6=Sat. ALL_DAYS_ORDER is Sat-first; this just maps
  // the two indexing schemes without hardcoding a second day list.
  const jsDay = now.getDay();
  const day = ALL_DAYS_ORDER[(jsDay + 1) % 7];
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return { day, time };
}

interface TimedSlot {
  dayOfWeek: DayOfWeek;
  startTime: string;
  endTime: string;
}

// A slot is "in progress" for a half-open [start, end) window — one ending
// exactly at the current minute reads as just-finished, not current,
// matching the same half-open convention lib/timetable-conflicts.ts uses
// for overlap checks.
function isInProgress(slot: TimedSlot, time: string): boolean {
  return timeToMinutes(slot.startTime) <= timeToMinutes(time) && timeToMinutes(time) < timeToMinutes(slot.endTime);
}

export interface NowClassification<T extends TimedSlot> {
  // The day actually being shown — equal to today unless nothing today (in
  // progress or upcoming) matched, in which case this walks forward to the
  // nearest future day that has at least one candidate.
  day: DayOfWeek;
  // True when `day` is a future day, not today — the UI uses this to show
  // "Nearest upcoming — {day}" instead of implying today has classes.
  isFallbackDay: boolean;
  inProgress: T[];
  next: T[];
}

const MAX_LOOKAHEAD_DAYS = 7;

// Classifies `candidates` (already scoped to the right semester + any
// class/lecturer/room/campus filter — day is NOT pre-filtered, since this
// function itself decides which day to show) into "in progress now" /
// "next today", falling forward up to a week if today has neither —
// e.g. it's a PT class's off-day, or simply after the last session of the
// day. Never reaches back to a day that has already passed. Sessions
// within each bucket are sorted by start time — "next" is the soonest
// first.
export function classifyForNow<T extends TimedSlot>(
  candidates: T[],
  now: Date = new Date()
): NowClassification<T> {
  const { day: today, time } = getCurrentDayAndTime(now);
  const todayIndex = ALL_DAYS_ORDER.indexOf(today);

  const todaySlots = candidates.filter((s) => s.dayOfWeek === today);
  const inProgress = todaySlots
    .filter((s) => isInProgress(s, time))
    .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  const next = todaySlots
    .filter((s) => timeToMinutes(s.startTime) > timeToMinutes(time))
    .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));

  if (inProgress.length > 0 || next.length > 0) {
    return { day: today, isFallbackDay: false, inProgress, next };
  }

  // TimetableSlot has no real date, only a recurring day-of-week — so
  // offset 7 landing back on TODAY's own weekday is not "reaching
  // backward," it's the legitimate next occurrence of a class that only
  // ever meets on that one day (e.g. a Monday-only session viewed on
  // Wednesday has no sooner occurrence than next Monday).
  for (let offset = 1; offset <= MAX_LOOKAHEAD_DAYS; offset++) {
    const candidateDay = ALL_DAYS_ORDER[(todayIndex + offset) % 7];
    const daySlots = candidates
      .filter((s) => s.dayOfWeek === candidateDay)
      .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
    if (daySlots.length > 0) {
      return { day: candidateDay, isFallbackDay: true, inProgress: [], next: daySlots };
    }
  }

  // Nothing at all in the next 7 days — stay on today with empty buckets;
  // the caller renders the standard empty state.
  return { day: today, isFallbackDay: false, inProgress: [], next: [] };
}

interface ShiftRange {
  startTime: string;
  endTime: string;
}

// A session "belongs" to a shift-based quick filter if its start time
// falls inside ANY ONE matching range's own [start, end) window —
// deliberately NOT a single min-to-max span across multiple ranges, so a
// gap between two non-contiguous ranges (e.g. 08:00-10:00 and
// 10:30-12:00) is never wrongly treated as a match. Used both for a
// single selected Shift (`[shift]`) and, in principle, any other set of
// time ranges.
export function matchesAnyShiftRange<T extends ShiftRange>(startTime: string, ranges: T[]): boolean {
  const t = timeToMinutes(startTime);
  return ranges.some((r) => t >= timeToMinutes(r.startTime) && t < timeToMinutes(r.endTime));
}
