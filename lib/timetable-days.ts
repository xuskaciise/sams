import type { DayOfWeek, StudyMode, Period } from "@prisma/client";

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
// (e.g. lecturer availability restriction reasons).
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

// ============================================================
// Lecturer availability — OPTIONAL hard scheduling constraint, day+shift
// granularity. See LecturerAvailability in schema.prisma and CLAUDE.md's
// "Lecturer availableDays" business rule. Re-entered fresh every
// auto-generate cycle via the wizard, never a permanent Lecturer
// Registration field. Zero rules overall = fully unrestricted, exactly
// today's default — every function below treats an empty `rules` array as
// a complete no-op.
// ============================================================

// A real Shift, carried by reference (not just its id) so every consumer
// — messages, the wizard's pre-fill, the workload-import feasibility
// check — can read its name/studyMode/period without a separate lookup.
export interface LecturerAvailabilityShiftRef {
  id: string;
  name: string;
  studyMode: StudyMode;
  period: Period | null;
}

// One day this lecturer is available on. Empty `shifts` = every shift on
// this day is allowed (the original day-level-only granularity);
// non-empty = ONLY these shifts on this day (day+shift level — e.g. Tue:
// Subax 1st+2nd only, Sat: Subax 2nd+3rd only, different shifts on
// different days for the same lecturer).
export interface LecturerAvailabilityDayRule {
  dayOfWeek: DayOfWeek;
  shifts: LecturerAvailabilityShiftRef[];
}

// The set of days genuinely possible for this lecturer, intersected with
// the class's own valid days — day-level only (mirrors the pre-day+shift
// restrictDaysToLecturerAvailability). Used both for the upfront
// zero-day-overlap check and to scope which day-COLUMNS a manual picker
// offers at all; which SHIFT-rows are further allowed within an offered
// day is a separate, per-day question — see isShiftAllowedForLecturerOnDay.
export function restrictedDaysForLecturer(days: DayOfWeek[], rules: LecturerAvailabilityDayRule[]): DayOfWeek[] {
  if (rules.length === 0) return days;
  const allowedDays = new Set(rules.map((r) => r.dayOfWeek));
  return days.filter((d) => allowedDays.has(d));
}

// True when this specific (day, shift) combination is allowed for this
// lecturer — the core per-cell check every placement/greying surface
// calls. Unrestricted lecturer (empty rules) -> always true. A day with
// no rule at all -> false (not one of their available days). A day whose
// rule has an empty shifts list -> true for ANY shift that day. A day
// whose rule has specific shifts -> true only if shiftId is among them.
export function isShiftAllowedForLecturerOnDay(
  day: DayOfWeek,
  shiftId: string,
  rules: LecturerAvailabilityDayRule[]
): boolean {
  if (rules.length === 0) return true;
  const entry = rules.find((r) => r.dayOfWeek === day);
  if (!entry) return false;
  if (entry.shifts.length === 0) return true;
  return entry.shifts.some((s) => s.id === shiftId);
}

// e.g. [{dayOfWeek: "TUE", shifts: [Subax 1st, Subax 2nd]}, {dayOfWeek:
// "SAT", shifts: []}] -> "Tue (Subax 1st, Subax 2nd) and Sat" — always in
// Saturday-first week order regardless of input order; a whole-day entry
// (empty shifts) shows just the day name, a shift-restricted one lists
// every allowed shift's name in parentheses.
export function formatAvailabilityRules(rules: LecturerAvailabilityDayRule[]): string {
  const byDay = new Map(rules.map((r) => [r.dayOfWeek, r]));
  return ALL_DAYS_ORDER.filter((d) => byDay.has(d))
    .map((d) => {
      const entry = byDay.get(d)!;
      return entry.shifts.length === 0
        ? DAY_SHORT_LABELS[d]
        : `${DAY_SHORT_LABELS[d]} (${entry.shifts.map((s) => s.name).join(", ")})`;
    })
    .join(" and ");
}

// Raw LecturerAvailability rows (as fetched with `shift` included) grouped
// back into the LecturerAvailabilityDayRule[] shape every consumer above
// expects — the one place this grouping logic lives, reused by every
// server-side fetch (previewAutoTimetableBatch's loadScopedAssignments,
// getPendingAutoTimetableAssignments, all three workload-import variants)
// so they can never disagree about what a given set of DB rows means.
export interface RawLecturerAvailabilityRow {
  dayOfWeek: DayOfWeek;
  // null = this row is the day-level-only marker (LecturerAvailability.shiftId
  // is null); a real ref = one of this day's allowed shifts.
  shift: LecturerAvailabilityShiftRef | null;
}

export function groupLecturerAvailabilityRows(rows: RawLecturerAvailabilityRow[]): LecturerAvailabilityDayRule[] {
  const byDay = new Map<DayOfWeek, LecturerAvailabilityShiftRef[]>();
  for (const row of rows) {
    if (!byDay.has(row.dayOfWeek)) byDay.set(row.dayOfWeek, []);
    if (row.shift) byDay.get(row.dayOfWeek)!.push(row.shift);
  }
  return [...byDay.entries()].map(([dayOfWeek, shifts]) => ({ dayOfWeek, shifts }));
}

// True if this one day's rule leaves at least one shift genuinely usable
// for a class of this studyMode/period — a whole-day rule (empty shifts)
// is always usable; a shift-restricted day is usable only if at least one
// of its listed shifts actually belongs to this studyMode (and, for FT,
// this period). Used by lecturerAvailabilityConflictReason's finer-grained
// check below.
function dayRuleUsableForClass(entry: LecturerAvailabilityDayRule, studyMode: StudyMode, period: Period | null): boolean {
  if (entry.shifts.length === 0) return true;
  return entry.shifts.some((s) => s.studyMode === studyMode && (studyMode !== "FT" || s.period === period));
}

// Workload Excel import validation (all three variants — Bulk/By Class/By
// Semester): a row can never possibly be satisfied by auto-generate when
// the matched lecturer's availability has ZERO overlap with the target
// class's own valid teaching days, OR when every overlapping day's
// shift-level restriction excludes every shift that class's
// studyMode/period could ever use — flagged as an import-time ERROR, same
// "report, don't silently create something that'll only fail later"
// pattern every other validation in that flow already uses. This is
// deliberately NOT a full bin-packing feasibility check against the
// row's own credit_hours (that's the generation algorithm's job,
// findClosestShiftCombo + the placement search) — it only rules out the
// cheap-to-detect, unambiguous case where literally no shift on any
// available day could ever work, exactly the same "only a complete
// mismatch is worth blocking" scope the original day-only check had. A
// studyMode that isn't set yet on the class can't be evaluated at all
// (nothing to intersect against) — returns null rather than guessing,
// matching this app's established nullable-studyMode fallback.
export function lecturerAvailabilityConflictReason(
  studyMode: StudyMode | null,
  period: Period | null,
  rules: LecturerAvailabilityDayRule[]
): string | null {
  if (rules.length === 0) return null;
  const classValidDays = getValidDaysForStudyMode(studyMode);
  if (classValidDays === null) return null;

  const overlapping = rules.filter((r) => classValidDays.includes(r.dayOfWeek));
  if (overlapping.length === 0) {
    return `Lecturer is only available ${formatAvailabilityRules(rules)} — none of those day(s) are valid teaching days for this class (${studyMode} classes meet ${formatDayList(classValidDays)})`;
  }

  const hasUsableDay = overlapping.some((r) => dayRuleUsableForClass(r, studyMode!, period));
  if (!hasUsableDay) {
    return `Lecturer is only available ${formatAvailabilityRules(rules)} — none of the shifts on those day(s) match this class's ${studyMode}${
      studyMode === "FT" && period ? ` ${period === "MORNING" ? "Morning" : "Afternoon"}` : ""
    } schedule`;
  }

  return null;
}
