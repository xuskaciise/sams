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
