import type { DayOfWeek, Period, StudyMode } from "@prisma/client";
import {
  findTimetableConflicts,
  timeToMinutes,
  type ConflictCandidateSlot,
} from "./timetable-conflicts";
import {
  getValidDaysForStudyMode,
  ALL_DAYS_ORDER,
  restrictDaysToLecturerAvailability,
  formatDayList,
} from "./timetable-days";

// ============================================================
// Shift-combination picking — NEVER invents a new time range, only
// combines whole EXISTING Shift templates for the class's studyMode.
// ============================================================

export interface ShiftTemplate {
  id: string;
  name: string;
  studyMode: StudyMode;
  // FT-only — Morning ("Subax") or Afternoon ("Galab"). Always null for a
  // PT shift, which has no period split. See CLAUDE.md's "Period"
  // business rule.
  period: Period | null;
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
  // The class's own period (Morning/Afternoon) — FT-only, see
  // ShiftTemplate.period. Null for PT (ignored entirely) or for an FT
  // class whose period hasn't been assigned yet (in which case no FT
  // shift will match — see the filtering in generateTimetableForBatch).
  period: Period | null;
  lecturerId: string;
  lecturerName: string;
  // OPTIONAL hard scheduling constraint (see Lecturer.availableDays in
  // schema.prisma) — empty means unrestricted, exactly today's behavior.
  // When non-empty, every session for this assignment is only ever placed
  // on a day that's BOTH valid for the class's studyMode/period AND in
  // this list — never relaxed by the spacing-fallback pass (see
  // generateTimetableForBatch).
  lecturerAvailableDays: DayOfWeek[];
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
  // Carried through so a client-side re-render (the auto-generate
  // overview's mini-grid/fullscreen drag-and-drop) can keep enforcing
  // this HARD constraint after the session leaves this pure function —
  // see components/timetable/schedule-grid.tsx. Empty = unrestricted.
  lecturerAvailableDays: DayOfWeek[];
  roomId: string;
  roomName: string;
  dayOfWeek: DayOfWeek;
  startTime: string;
  endTime: string;
  shiftId: string;
  shiftName: string;
  // 1-based position of this session among this assignment's own sessions
  // (from its shift combo/override) — e.g. sessionNumber 2 of
  // sessionCount 2 for the second of two 1.5h sessions making up a
  // 3-credit-hour course. Lets the UI label "Session 1 of 2" instead of
  // two visually-identical rows.
  sessionNumber: number;
  sessionCount: number;
}

export interface FallbackNote {
  assignmentId: string;
  className: string;
  courseName: string;
  message: string;
}

export interface UnscheduledItem {
  assignmentId: string;
  classId: string;
  className: string;
  courseName: string;
  lecturerName: string;
  // Same carry-through as ScheduledSession.lecturerAvailableDays.
  lecturerAvailableDays: DayOfWeek[];
  reason: string;
  // The PREFERRED shift for this session (the one the credit-hour combo
  // picked) — still reported even though placement now also tries every
  // OTHER shift for the study mode before giving up, so the UI can show
  // what was originally targeted.
  shiftId: string;
  shiftName: string;
  sessionNumber: number;
  sessionCount: number;
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

// Preferred shift first (the one the credit-hour combo picked for THIS
// session), then every other shift for the study mode in their existing
// stable order. This is the BUG 1 fix: placement used to try ONLY the
// preferred shift's own time across every day, so once that ONE specific
// (room, shift) combination was booked out across every valid day by
// other assignments sharing the same room (a very real scenario — many
// classes commonly share a small pool of rooms, and many courses commonly
// land on the same "closest" shift for a given credit-hour value), every
// later assignment needing that same preferred shift failed identically,
// even though a genuinely different shift template was still wide open.
// Placement below now tries the FULL (day × shift) cross-product before
// giving up — see generateTimetableForBatch.
function orderShiftsByPreference(
  preferred: ShiftTemplate,
  shiftsForMode: ShiftTemplate[]
): ShiftTemplate[] {
  const rest = shiftsForMode.filter((s) => s.id !== preferred.id);
  return [preferred, ...rest];
}

// Tries every (day, shift) combination — preferred shift first, in
// day-then-shift priority order matching the spacing rule — and returns
// the first conflict-free placement, or null if genuinely none exists.
// `onlyUnusedDays`, when true, is Pass 1 of the spacing rule (skips any
// day already used by this assignment); when false, it's Pass 2 (every
// valid day, including reused ones — a DIFFERENT shift/time on that day
// is what makes a reused day possible at all, since the identical
// shift+day was already tried and would self-conflict).
interface ConflictCheckInputForSchedule {
  roomId: string;
  lecturerId: string;
  classId: string;
}

function findFirstOpenSlot(
  shiftOrder: ShiftTemplate[],
  validDays: DayOfWeek[],
  usedDaysForAssignment: Set<DayOfWeek>,
  onlyUnusedDays: boolean,
  baseInput: ConflictCheckInputForSchedule,
  candidates: ConflictCandidateSlot[]
): { day: DayOfWeek; shift: ShiftTemplate } | null {
  for (const shift of shiftOrder) {
    for (const day of validDays) {
      if (onlyUnusedDays && usedDaysForAssignment.has(day)) continue;
      const conflicts = findTimetableConflicts(
        {
          dayOfWeek: day,
          startTime: shift.startTime,
          endTime: shift.endTime,
          roomId: baseInput.roomId,
          lecturerId: baseInput.lecturerId,
          classId: baseInput.classId,
        },
        candidates
      );
      if (conflicts.length === 0) return { day, shift };
    }
  }
  return null;
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
// and its fallback (last resort) exactly — but, per the BUG 1 fix, each
// pass now searches the FULL (shift × day) cross-product, not just the
// one shift the credit-hour combo happened to prefer:
//   Pass 1 — only days NOT yet used by this same assignment, tried across
//   every available shift (preferred one first). Encodes "never schedule
//   the same course/lecturer twice on a day if any other valid day still
//   has room," while no longer giving up just because the ONE preferred
//   shift specifically is booked out.
//   Pass 2 — only reached if pass 1 placed nothing anywhere: every valid
//   day, including ones already used by this assignment, again across
//   every available shift. A different shift/time on an already-used day
//   is fine (the CLASS/LECTURER candidate from the earlier session on
//   that day only conflicts if the new time overlaps it); the exact same
//   shift+day is impossible by construction, since that would
//   self-conflict as a CLASS/LECTURER hit.
// Only when NEITHER pass finds a conflict-free (day, shift) pair anywhere
// in the full cross-product is the session Unscheduled — never
// force-placed. An explicit per-assignment shift OVERRIDE (an admin's
// deliberate choice, not the algorithm's own pick) is exempt from this
// fallback — it's tried at its own exact shift only, same as before,
// since silently substituting a different shift would contradict what
// was explicitly requested.
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
    const classValidDays = getValidDaysForStudyMode(a.studyMode) ?? ALL_DAYS_ORDER;
    // HARD constraint, applied on top of the class's own FT/PT + Period
    // valid-day rules — never relaxed by the Pass 2 spacing fallback below
    // (both passes only ever search within `validDays`, which is already
    // this restricted list). An unrestricted lecturer (empty
    // availableDays) gets classValidDays back unchanged, so nothing here
    // changes behavior for lecturers without this set.
    const validDays = restrictDaysToLecturerAvailability(classValidDays, a.lecturerAvailableDays);
    const lecturerRestricted = a.lecturerAvailableDays.length > 0;

    // If the restriction leaves NO valid day at all (e.g. a lecturer
    // available only Thu/Fri assigned to an FT class, which only ever
    // meets Sat-Wed), this assignment can never be scheduled regardless of
    // room/shift — report it once for the whole assignment, before any
    // shift-combo work, rather than searching a shift for a day set that's
    // already empty.
    if (lecturerRestricted && validDays.length === 0) {
      unscheduled.push({
        assignmentId: a.assignmentId,
        classId: a.classId,
        className: a.className,
        courseName: a.courseName,
        lecturerName: a.lecturerName,
        lecturerAvailableDays: a.lecturerAvailableDays,
        reason: `Lecturer only available ${formatDayList(a.lecturerAvailableDays)} — none of those day(s) are valid teaching days for this class.`,
        shiftId: "",
        shiftName: "",
        sessionNumber: 1,
        sessionCount: 1,
      });
      continue;
    }

    const shiftsForModeAll = a.studyMode ? (shiftsByStudyMode.get(a.studyMode) ?? []) : [];
    // Period restriction is FT-only — an FT class's shift search is
    // narrowed to ONLY shifts sharing its own period (a Morning-period
    // class only ever tries Subax shifts, never Galab, and vice versa).
    // PT is completely unaffected — it has no period concept, so every PT
    // shift stays in play exactly as before. An FT class with no period
    // assigned yet (period === null) matches only equally period-less FT
    // shifts, which should not exist once period is entry-enforced — this
    // naturally falls through to the "no shift templates" reason below
    // rather than silently ignoring the restriction.
    const shiftsForMode =
      a.studyMode === "FT" ? shiftsForModeAll.filter((s) => s.period === a.period) : shiftsForModeAll;
    const isExplicitOverride = Boolean(a.shiftOverrideIds && a.shiftOverrideIds.length > 0);

    let sessionShifts: ShiftTemplate[];
    if (isExplicitOverride) {
      sessionShifts = a.shiftOverrideIds!
        .map((id) => shiftsForMode.find((s) => s.id === id))
        .filter((s): s is ShiftTemplate => Boolean(s));
    } else {
      const combo = findClosestShiftCombo(a.creditHours, shiftsForMode);
      if (!combo) {
        unscheduled.push({
          assignmentId: a.assignmentId,
          classId: a.classId,
          className: a.className,
          courseName: a.courseName,
          lecturerName: a.lecturerName,
          lecturerAvailableDays: a.lecturerAvailableDays,
          reason:
            "No Shift templates exist for this class's study mode — cannot determine a session length.",
          shiftId: "",
          shiftName: "",
          sessionNumber: 1,
          sessionCount: 1,
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
    const sessionCount = sessionShifts.length;
    const baseInput: ConflictCheckInputForSchedule = {
      roomId: a.mainRoomId,
      lecturerId: a.lecturerId,
      classId: a.classId,
    };

    for (let i = 0; i < sessionShifts.length; i++) {
      const preferredShift = sessionShifts[i];
      const sessionNumber = i + 1;
      const shiftOrder = isExplicitOverride
        ? [preferredShift]
        : orderShiftsByPreference(preferredShift, shiftsForMode);
      const candidates = [...existingCandidates, ...batchPlaced];

      // Pass 1 — unused days, every shift.
      let placement = findFirstOpenSlot(
        shiftOrder,
        validDays,
        usedDaysForAssignment,
        true,
        baseInput,
        candidates
      );
      let usedFallback = false;

      // Pass 2 — fallback: every valid day (including already-used ones),
      // every shift.
      if (!placement) {
        placement = findFirstOpenSlot(
          shiftOrder,
          validDays,
          usedDaysForAssignment,
          false,
          baseInput,
          candidates
        );
        usedFallback = placement !== null;
      }

      if (!placement) {
        unscheduled.push({
          assignmentId: a.assignmentId,
          classId: a.classId,
          className: a.className,
          courseName: a.courseName,
          lecturerName: a.lecturerName,
          lecturerAvailableDays: a.lecturerAvailableDays,
          reason: isExplicitOverride
            ? `No valid day remains for the overridden shift ${preferredShift.name} (${preferredShift.startTime}-${preferredShift.endTime}) without conflicting with an existing booking.`
            : lecturerRestricted
              ? `Lecturer only available ${formatDayList(a.lecturerAvailableDays)} — no open slot on ${
                  validDays.length === 1 ? "that day" : "any of those days"
                } (${formatDayList(validDays)}) for this class.`
              : `No valid day/shift combination remains for this session — tried all ${shiftOrder.length} shift(s) across all ${validDays.length} valid day(s) for this class's study mode without finding one free of conflicts.`,
          shiftId: preferredShift.id,
          shiftName: preferredShift.name,
          sessionNumber,
          sessionCount,
        });
        continue;
      }

      const { day: placedDay, shift: placedShift } = placement;
      usedDaysForAssignment.add(placedDay);
      const session: ScheduledSession = {
        assignmentId: a.assignmentId,
        classId: a.classId,
        className: a.className,
        courseName: a.courseName,
        lecturerId: a.lecturerId,
        lecturerName: a.lecturerName,
        lecturerAvailableDays: a.lecturerAvailableDays,
        roomId: a.mainRoomId,
        roomName: a.mainRoomName,
        dayOfWeek: placedDay,
        startTime: placedShift.startTime,
        endTime: placedShift.endTime,
        shiftId: placedShift.id,
        shiftName: placedShift.name,
        sessionNumber,
        sessionCount,
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
// Sequential semesterNumber eligibility — which Class.currentSemesterNumber
// values (1..8, a batch's cycle level — NOT Semester.semesterNumber, see
// CLAUDE.md's "Add/Edit Semester" bullet for the distinction between the
// two) can be auto-generated THIS cycle depends on which real
// academic-calendar Semester is currently active: Semester 1 active ->
// only ODD class levels (1,3,5,7) are mid-cycle; Semester 2 active -> only
// EVEN ones (2,4,6,8). This is a single institution-wide fact (the whole
// school advances together via the Open Semester wizard), so it's always
// resolved ONCE from the active Semester's own semesterNumber and applied
// uniformly — never re-derived per assignment/group. Within the eligible
// set, processing is still ascending order, same as before.
// ============================================================

export type SemesterLevelParity = "ODD" | "EVEN";

// null when there's no active academic Semester, or its semesterNumber
// hasn't been set (a nullable legacy field — see Semester.semesterNumber's
// schema comment) — eligibility genuinely can't be determined then, so
// callers must treat every level as ineligible rather than guess.
export function parityForAcademicSemesterNumber(
  activeAcademicSemesterNumber: number | null
): SemesterLevelParity | null {
  if (activeAcademicSemesterNumber === 1) return "ODD";
  if (activeAcademicSemesterNumber === 2) return "EVEN";
  return null;
}

export interface SemesterLevelEligibility {
  // Ascending, deduplicated, matching the active semester's parity —
  // exactly what used to be sequentialOddSemesterNumbers's whole result.
  eligible: number[];
  // Ascending, deduplicated, present in the input but the WRONG parity for
  // right now (or everything, when parity is null) — never silently
  // dropped, always reported back so the caller can explain why.
  ineligible: number[];
}

export function classifySemesterNumbersByEligibility(
  semesterNumbers: (number | null)[],
  activeAcademicSemesterNumber: number | null
): SemesterLevelEligibility {
  const parity = parityForAcademicSemesterNumber(activeAcademicSemesterNumber);
  const eligible = new Set<number>();
  const ineligible = new Set<number>();
  for (const n of semesterNumbers) {
    if (n === null) continue;
    const isOdd = n % 2 === 1;
    const matches = parity === "ODD" ? isOdd : parity === "EVEN" ? !isOdd : false;
    (matches ? eligible : ineligible).add(n);
  }
  return {
    eligible: [...eligible].sort((a, b) => a - b),
    ineligible: [...ineligible].sort((a, b) => a - b),
  };
}

// Human-readable explanation for a non-empty `ineligible` set — the "don't
// silently ignore them" requirement. Reused by both the generator (a
// banner at the top of the flow) and the pending-assignments card (its own
// summary), so the wording can never drift between the two.
export function describeIneligibleLevels(
  ineligibleLevels: number[],
  activeAcademicSemesterNumber: number | null
): string | null {
  if (ineligibleLevels.length === 0) return null;
  const levelsText = ineligibleLevels.join(", ");
  if (activeAcademicSemesterNumber !== 1 && activeAcademicSemesterNumber !== 2) {
    return `Semester level(s) ${levelsText} can't be checked for eligibility right now — the active academic semester's number hasn't been set. Set it under Academic Calendar > Semesters.`;
  }
  const parity = parityForAcademicSemesterNumber(activeAcademicSemesterNumber);
  const levelKind = parity === "ODD" ? "even" : "odd";
  const otherAcademicSemesterNumber = activeAcademicSemesterNumber === 1 ? 2 : 1;
  return `These assignments are for ${levelKind}-level classes (${levelsText}), which are scheduled during Semester ${otherAcademicSemesterNumber} — they'll become available for generation once Semester ${otherAcademicSemesterNumber} is active again.`;
}
