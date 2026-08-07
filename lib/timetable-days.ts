import type { DayOfWeek, StudyMode } from "@prisma/client";

// The academic week here starts Saturday, not Monday. A class's valid
// teaching days depend on its studyMode; times are free-form within
// those days (no fixed shift hours). A class with no studyMode set yet
// (Class.studyMode is nullable — legacy/incomplete batch data) has no day
// restriction at all, matching this app's established fallback for other
// nullable batch fields elsewhere.
export const VALID_DAYS_BY_STUDY_MODE: Record<StudyMode, DayOfWeek[]> = {
  FT: ["SAT", "SUN", "MON", "TUE", "WED"],
  PT: ["THU", "FRI"],
};

// Full-week fallback order (Saturday-first, matching this app's academic
// calendar) — used whenever a caller needs every day regardless of
// studyMode (e.g. slots spanning more than one studyMode, or none).
export const ALL_DAYS_ORDER: DayOfWeek[] = ["SAT", "SUN", "MON", "TUE", "WED", "THU", "FRI"];

export const DAY_LABELS: Record<DayOfWeek, string> = {
  SUN: "Sunday",
  MON: "Monday",
  TUE: "Tuesday",
  WED: "Wednesday",
  THU: "Thursday",
  FRI: "Friday",
  SAT: "Saturday",
};

export function getValidDaysForStudyMode(studyMode: StudyMode | null): DayOfWeek[] | null {
  if (!studyMode) return null;
  return VALID_DAYS_BY_STUDY_MODE[studyMode];
}

export function isValidDayForStudyMode(day: DayOfWeek, studyMode: StudyMode | null): boolean {
  const validDays = getValidDaysForStudyMode(studyMode);
  return validDays === null || validDays.includes(day);
}

// Short 3-letter form, used in compact UI labels and generated messages
// (e.g. Lecturer.availableDays restriction reasons).
export const DAY_SHORT_LABELS: Record<DayOfWeek, string> = {
  SUN: "Sun",
  MON: "Mon",
  TUE: "Tue",
  WED: "Wed",
  THU: "Thu",
  FRI: "Fri",
  SAT: "Sat",
};

// e.g. ["SAT", "WED"] -> "Sat/Wed" — always in the app's Saturday-first
// week order regardless of the input order.
export function formatDayList(days: DayOfWeek[]): string {
  return ALL_DAYS_ORDER.filter((d) => days.includes(d))
    .map((d) => DAY_SHORT_LABELS[d])
    .join("/");
}

// OPTIONAL hard scheduling constraint (see Lecturer.availableDays in
// schema.prisma). Empty/no restriction -> `days` unchanged. A non-empty
// restriction narrows `days` down to exactly the intersection — this is
// the one function both the auto-generate algorithm and the manual
// builder/single-slot pickers call, so "which days are actually offered/
// tried" can never drift between the two.
export function restrictDaysToLecturerAvailability(
  days: DayOfWeek[],
  lecturerAvailableDays: DayOfWeek[]
): DayOfWeek[] {
  if (lecturerAvailableDays.length === 0) return days;
  return days.filter((d) => lecturerAvailableDays.includes(d));
}

// Workload Excel import validation (all three variants — Bulk/By Class/By
// Semester): a row can never possibly be satisfied by auto-generate when
// the matched lecturer's availableDays has ZERO overlap with the target
// class's own valid teaching days — flagged as an import-time ERROR, same
// "report, don't silently create something that'll only fail later"
// pattern every other validation in that flow already uses. A studyMode
// that isn't set yet on the class can't be evaluated at all (nothing to
// intersect against) — returns null (no conflict reported) rather than
// guessing, matching this app's established nullable-studyMode fallback.
// A PARTIAL overlap is never flagged here — the row is still genuinely
// schedulable, just more constrained; only a complete mismatch is a
// guaranteed failure worth blocking at import time.
export function lecturerAvailabilityConflictReason(
  studyMode: StudyMode | null,
  lecturerAvailableDays: DayOfWeek[]
): string | null {
  if (lecturerAvailableDays.length === 0) return null;
  const classValidDays = getValidDaysForStudyMode(studyMode);
  if (classValidDays === null) return null;
  const hasOverlap = classValidDays.some((d) => lecturerAvailableDays.includes(d));
  if (hasOverlap) return null;
  return `Lecturer is only available ${formatDayList(lecturerAvailableDays)} — none of those day(s) are valid teaching days for this class (${studyMode} classes meet ${formatDayList(classValidDays)})`;
}
