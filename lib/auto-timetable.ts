import type { DayOfWeek, StudyMode } from "@prisma/client";
import {
  findTimetableConflicts,
  timeToMinutes,
  type ConflictCandidateSlot,
} from "./timetable-conflicts";
import { getValidDaysForStudyMode, ALL_DAYS_ORDER } from "./timetable-days";

// ============================================================
// Shift-combination picking — NEVER invents a new time range, only
// combines whole EXISTING Shift templates for the class's studyMode.
// ============================================================

export interface ShiftTemplate {
  id: string;
  name: string;
  studyMode: StudyMode;
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
}

export function shiftHours(shift: Pick<ShiftTemplate, "startTime" | "endTime">): number {
  return (timeToMinutes(shift.endTime) - timeToMinutes(shift.startTime)) / 60;
}

export interface ShiftCombo {
  // One entry per session — the same shift template may repeat (e.g. a
  // 1.5h shift used twice for a 3-credit-hour course), each occurrence
  // becoming its own session on a different day.
  shifts: ShiftTemplate[];
  totalHours: number;
  // totalHours - target: positive = over, negative = under, 0 = exact.
  diffHours: number;
  exact: boolean;
}

const MAX_SESSIONS = 6;
const EPSILON = 0.01;

// Finds the multiset of existing Shift templates whose combined duration
// comes closest to `targetHours`. Prefers an exact match (stops searching
// as soon as one is found); among non-exact matches, prefers the smallest
// absolute difference, then the fewest sessions, then a stable shift
// order — so the same input always yields the same result. Returns null
// only when there are no shifts to combine at all (nothing to schedule
// with) or a non-positive target.
export function findClosestShiftCombo(
  targetHours: number,
  shiftsForStudyMode: ShiftTemplate[]
): ShiftCombo | null {
  if (shiftsForStudyMode.length === 0 || targetHours <= 0) return null;
  const sorted = [...shiftsForStudyMode].sort((a, b) => a.id.localeCompare(b.id));

  const candidates: ShiftCombo[] = [];

  function build(startIdx: number, combo: ShiftTemplate[], size: number) {
    if (combo.length === size) {
      const totalHours = combo.reduce((sum, s) => sum + shiftHours(s), 0);
      const diffHours = totalHours - targetHours;
      candidates.push({
        shifts: [...combo],
        totalHours,
        diffHours,
        exact: Math.abs(diffHours) < EPSILON,
      });
      return;
    }
    for (let i = startIdx; i < sorted.length; i++) {
      combo.push(sorted[i]);
      build(i, combo, size);
      combo.pop();
    }
  }

  // Iterative deepening BY SESSION COUNT — all combinations-with-repetition
  // of size 1, then size 2, etc. An exact match (diffHours === 0) is the
  // global minimum possible |diff|, so as soon as one is found at a given
  // size, it's both optimal AND uses the fewest sessions among exact
  // matches (a larger size is never even explored).
  for (let size = 1; size <= MAX_SESSIONS; size++) {
    build(0, [], size);
    if (candidates.some((c) => c.exact)) break;
  }
  if (candidates.length === 0) return null;

  // Prefer the smallest absolute difference; among near-ties, prefer
  // fewer sessions; otherwise keep whichever was found first (stable
  // sorted-shift order), so the same input always yields the same result.
  let best = candidates[0];
  for (const c of candidates) {
    if (
      Math.abs(c.diffHours) < Math.abs(best.diffHours) - EPSILON ||
      (Math.abs(Math.abs(c.diffHours) - Math.abs(best.diffHours)) < EPSILON &&
        c.shifts.length < best.shifts.length)
    ) {
      best = c;
    }
  }
  return best;
}

export function describeCombo(shifts: ShiftTemplate[]): string {
  const counts = new Map<string, { shift: ShiftTemplate; count: number }>();
  for (const s of shifts) {
    const entry = counts.get(s.id);
    if (entry) entry.count++;
    else counts.set(s.id, { shift: s, count: 1 });
  }
  return [...counts.values()]
    .map(({ shift, count }) => `${count} ${shiftHours(shift)}h shift${count > 1 ? "s" : ""} (${shift.name})`)
    .join(", ");
}

// ============================================================
// Sequential scheduling for one semesterNumber batch.
// ============================================================

export interface AssignmentToSchedule {
  assignmentId: string;
  classId: string;
  className: string;
  studyMode: StudyMode | null;
  lecturerId: string;
  lecturerName: string;
  courseId: string;
  courseName: string;
  creditHours: number;
  mainRoomId: string;
  mainRoomName: string;
  // Optional per-assignment override: explicit Shift ids to use instead of
  // the auto-picked closest combo — still only ever real, existing Shift
  // records, just chosen by the admin/dean instead of the algorithm.
  shiftOverrideIds?: string[];
}

export interface ScheduledSession {
  assignmentId: string;
  classId: string;
  className: string;
  courseName: string;
  lecturerId: string;
  lecturerName: string;
  roomId: string;
  roomName: string;
  dayOfWeek: DayOfWeek;
  startTime: string;
  endTime: string;
  shiftId: string;
  shiftName: string;
}

export interface FallbackNote {
  assignmentId: string;
  className: string;
  courseName: string;
  message: string;
}

export interface UnscheduledItem {
  assignmentId: string;
  className: string;
  courseName: string;
  lecturerName: string;
  reason: string;
  shiftId: string;
  shiftName: string;
}

export interface ComboWarning {
  assignmentId: string;
  className: string;
  courseName: string;
  message: string;
}

export interface GenerationResult {
  scheduledNormally: ScheduledSession[];
  scheduledWithFallback: ScheduledSession[];
  fallbackNotes: FallbackNote[];
  unscheduled: UnscheduledItem[];
  comboWarnings: ComboWarning[];
}

function sessionAsCandidate(session: ScheduledSession, key: string): ConflictCandidateSlot {
  return {
    id: key,
    dayOfWeek: session.dayOfWeek,
    startTime: session.startTime,
    endTime: session.endTime,
    roomId: session.roomId,
    roomName: session.roomName,
    lecturerId: session.lecturerId,
    lecturerName: session.lecturerName,
    classId: session.classId,
    className: session.className,
    courseName: session.courseName,
  };
}

// Schedules every assignment in `assignments` (all belonging to ONE
// semesterNumber batch — the caller groups by Class.currentSemesterNumber
// and calls this once per batch, in ascending odd order) against
// `existingCandidates` (already-confirmed TimetableSlots for the same real
// Semester — including any earlier semesterNumber batch already confirmed
// in this same generation run, since those are real DB rows by the time
// the next batch is previewed) plus every OTHER session placed earlier in
// THIS call (a batch can conflict with itself before anything is written,
// same reasoning as findWeekBuilderConflicts). Pure and DB-free — the
// caller is responsible for fetching `existingCandidates` fresh and
// resolving each class's room/studyMode/shifts first.
//
// Two-pass placement per session, implementing the spacing rule (default)
// and its fallback (last resort) exactly:
//   Pass 1 — only days NOT yet used by this same assignment. Encodes
//   "never schedule the same course/lecturer twice on a day if any other
//   valid day still has room."
//   Pass 2 — only reached if pass 1 placed nothing: every valid day,
//   including ones already used by this assignment. A different
//   shift/time on an already-used day is fine (the CLASS/LECTURER
//   candidate from the earlier session on that day only conflicts if the
//   new time overlaps it); the exact same time is impossible by
//   construction, since that would self-conflict as a CLASS/LECTURER hit.
// If neither pass finds a conflict-free day, the session is Unscheduled —
// never force-placed.
export function generateTimetableForBatch(
  assignments: AssignmentToSchedule[],
  shiftsByStudyMode: Map<StudyMode, ShiftTemplate[]>,
  existingCandidates: ConflictCandidateSlot[]
): GenerationResult {
  const scheduledNormally: ScheduledSession[] = [];
  const scheduledWithFallback: ScheduledSession[] = [];
  const fallbackNotes: FallbackNote[] = [];
  const unscheduled: UnscheduledItem[] = [];
  const comboWarnings: ComboWarning[] = [];
  const batchPlaced: ConflictCandidateSlot[] = [];
  let placedKeySeq = 0;

  const sorted = [...assignments].sort(
    (a, b) => a.className.localeCompare(b.className) || a.courseName.localeCompare(b.courseName)
  );

  for (const a of sorted) {
    const validDays = getValidDaysForStudyMode(a.studyMode) ?? ALL_DAYS_ORDER;
    const shiftsForMode = a.studyMode ? (shiftsByStudyMode.get(a.studyMode) ?? []) : [];

    let sessionShifts: ShiftTemplate[];
    if (a.shiftOverrideIds && a.shiftOverrideIds.length > 0) {
      sessionShifts = a.shiftOverrideIds
        .map((id) => shiftsForMode.find((s) => s.id === id))
        .filter((s): s is ShiftTemplate => Boolean(s));
    } else {
      const combo = findClosestShiftCombo(a.creditHours, shiftsForMode);
      if (!combo) {
        unscheduled.push({
          assignmentId: a.assignmentId,
          className: a.className,
          courseName: a.courseName,
          lecturerName: a.lecturerName,
          reason:
            "No Shift templates exist for this class's study mode — cannot determine a session length.",
          shiftId: "",
          shiftName: "",
        });
        continue;
      }
      sessionShifts = combo.shifts;
      if (!combo.exact) {
        const overUnder = combo.diffHours > 0 ? "over" : "under";
        comboWarnings.push({
          assignmentId: a.assignmentId,
          className: a.className,
          courseName: a.courseName,
          message: `${a.creditHours} credit hour(s) requested, ${combo.totalHours} scheduled using ${describeCombo(
            combo.shifts
          )} — ${Math.abs(combo.diffHours)}h ${overUnder}, review recommended.`,
        });
      }
    }

    const usedDaysForAssignment = new Set<DayOfWeek>();

    for (const shift of sessionShifts) {
      const baseInput = {
        startTime: shift.startTime,
        endTime: shift.endTime,
        roomId: a.mainRoomId,
        lecturerId: a.lecturerId,
        classId: a.classId,
      };

      let placedDay: DayOfWeek | null = null;
      let usedFallback = false;

      // Pass 1 — unused days only.
      for (const day of validDays) {
        if (usedDaysForAssignment.has(day)) continue;
        const conflicts = findTimetableConflicts({ ...baseInput, dayOfWeek: day }, [
          ...existingCandidates,
          ...batchPlaced,
        ]);
        if (conflicts.length === 0) {
          placedDay = day;
          break;
        }
      }

      // Pass 2 — fallback: every valid day, including already-used ones.
      if (!placedDay) {
        for (const day of validDays) {
          const conflicts = findTimetableConflicts({ ...baseInput, dayOfWeek: day }, [
            ...existingCandidates,
            ...batchPlaced,
          ]);
          if (conflicts.length === 0) {
            placedDay = day;
            usedFallback = true;
            break;
          }
        }
      }

      if (!placedDay) {
        unscheduled.push({
          assignmentId: a.assignmentId,
          className: a.className,
          courseName: a.courseName,
          lecturerName: a.lecturerName,
          reason: `No valid day/shift remains for ${shift.name} (${shift.startTime}-${shift.endTime}) without conflicting with an existing booking.`,
          shiftId: shift.id,
          shiftName: shift.name,
        });
        continue;
      }

      usedDaysForAssignment.add(placedDay);
      const session: ScheduledSession = {
        assignmentId: a.assignmentId,
        classId: a.classId,
        className: a.className,
        courseName: a.courseName,
        lecturerId: a.lecturerId,
        lecturerName: a.lecturerName,
        roomId: a.mainRoomId,
        roomName: a.mainRoomName,
        dayOfWeek: placedDay,
        startTime: shift.startTime,
        endTime: shift.endTime,
        shiftId: shift.id,
        shiftName: shift.name,
      };

      batchPlaced.push(sessionAsCandidate(session, `batch:${placedKeySeq++}`));

      if (usedFallback) {
        scheduledWithFallback.push(session);
        fallbackNotes.push({
          assignmentId: a.assignmentId,
          className: a.className,
          courseName: a.courseName,
          message: `Note: ${a.courseName} double-booked on ${placedDay} for ${a.className} because no other valid day had room — review recommended.`,
        });
      } else {
        scheduledNormally.push(session);
      }
    }
  }

  return { scheduledNormally, scheduledWithFallback, fallbackNotes, unscheduled, comboWarnings };
}

// ============================================================
// Sequential semesterNumber ordering — ALWAYS ascending odd numbers
// present in the batch (1, 3, 5, 7…), never even, never all at once, never
// configurable. See CLAUDE.md's "Workload Excel import + auto-timetable
// generation" business rule for why (Class.currentSemesterNumber, not
// Semester.semesterNumber — see the comment there for the distinction).
// ============================================================

export function sequentialOddSemesterNumbers(semesterNumbers: (number | null)[]): number[] {
  const odds = new Set<number>();
  for (const n of semesterNumbers) {
    if (n !== null && n % 2 === 1) odds.add(n);
  }
  return [...odds].sort((a, b) => a - b);
}
