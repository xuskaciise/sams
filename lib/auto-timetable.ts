import type { DayOfWeek, Period, StudyMode } from "@prisma/client";
import {
  findTimetableConflicts,
  timeToMinutes,
  type ConflictCandidateSlot,
} from "./timetable-conflicts";
import {
  getValidDaysForStudyMode,
  ALL_DAYS_ORDER,
  DAY_SHORT_LABELS,
  restrictedDaysForLecturer,
  isShiftAllowedForLecturerOnDay,
  formatAvailabilityRules,
  type LecturerAvailabilityDayRule,
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
  // OPTIONAL hard scheduling constraint, day+shift granularity (see
  // LecturerAvailability in schema.prisma) — empty means unrestricted,
  // exactly today's behavior. When non-empty, every session for this
  // assignment is only ever placed on a (day, shift) combination that's
  // BOTH valid for the class's studyMode/period AND allowed by this list
  // (isShiftAllowedForLecturerOnDay) — never relaxed by the
  // spacing-fallback pass (see generateTimetableForBatch).
  lecturerAvailability: LecturerAvailabilityDayRule[];
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
  lecturerAvailability: LecturerAvailabilityDayRule[];
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
  // Same carry-through as ScheduledSession.lecturerAvailability.
  lecturerAvailability: LecturerAvailabilityDayRule[];
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

export interface BacktrackingStats {
  // How many sessions the initial greedy pass (Phase 1) left unresolved
  // and handed to the backtracking search (Phase 2).
  attempted: number;
  // How many of those the backtracking search actually managed to seat
  // (by displacing and relocating one or more already-placed sessions).
  resolved: number;
  // True if the search stopped because its time budget ran out, not
  // because it exhausted every possibility — some of `attempted -
  // resolved` may still have been placeable given more time.
  timedOut: boolean;
  elapsedMs: number;
}

export interface GenerationResult {
  scheduledNormally: ScheduledSession[];
  scheduledWithFallback: ScheduledSession[];
  fallbackNotes: FallbackNote[];
  unscheduled: UnscheduledItem[];
  comboWarnings: ComboWarning[];
  backtrackingStats: BacktrackingStats;
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
  candidates: ConflictCandidateSlot[],
  lecturerAvailability: LecturerAvailabilityDayRule[],
  // Backtracking-only: (day, shift) pairs an ANCESTOR in the current
  // displacement chain has already claimed for itself. A slot can look
  // conflict-free right here (its previous occupant was just tentatively
  // removed to make room for that ancestor) while still being off-limits
  // to THIS search — skipping it is what stops a displaced session from
  // being "relocated" right back into the exact slot it was bumped from.
  // Always empty for Phase 1's own calls (no chain exists yet).
  avoidSlots?: ReadonlySet<string>
): { day: DayOfWeek; shift: ShiftTemplate } | null {
  for (const shift of shiftOrder) {
    for (const day of validDays) {
      if (onlyUnusedDays && usedDaysForAssignment.has(day)) continue;
      if (avoidSlots?.has(`${day}:${shift.id}`)) continue;
      // Day+shift granularity — a day-level-only restriction already
      // narrowed `validDays` above (restrictedDaysForLecturer), but a
      // day CAN be present in validDays while still excluding THIS
      // particular shift (a shift-restricted day, e.g. Tue: Subax 1st+2nd
      // only) — checked per (day, shift) pair, never bypassed by either
      // pass.
      if (!isShiftAllowedForLecturerOnDay(day, shift.id, lecturerAvailability)) continue;
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

// One of this assignment's own sessions, still pending a placement — built
// once per session regardless of whether Phase 1's greedy pass manages to
// seat it immediately, so a session that Phase 1 fails on can be retried
// uniformly by Phase 2's backtracking search below without recomputing its
// shift-combo/valid-days/lecturer-restriction context from scratch.
interface PendingSession {
  assignment: AssignmentToSchedule;
  sessionNumber: number;
  sessionCount: number;
  preferredShift: ShiftTemplate;
  shiftOrder: ShiftTemplate[];
  validDays: DayOfWeek[];
  isExplicitOverride: boolean;
  lecturerRestricted: boolean;
  baseInput: ConflictCheckInputForSchedule;
}

interface PlacedRecord {
  pending: PendingSession;
  session: ScheduledSession;
}

function sessionFromPlacement(
  pending: PendingSession,
  day: DayOfWeek,
  shift: ShiftTemplate
): ScheduledSession {
  const a = pending.assignment;
  return {
    assignmentId: a.assignmentId,
    classId: a.classId,
    className: a.className,
    courseName: a.courseName,
    lecturerId: a.lecturerId,
    lecturerName: a.lecturerName,
    lecturerAvailability: a.lecturerAvailability,
    roomId: a.mainRoomId,
    roomName: a.mainRoomName,
    dayOfWeek: day,
    startTime: shift.startTime,
    endTime: shift.endTime,
    shiftId: shift.id,
    shiftName: shift.name,
    sessionNumber: pending.sessionNumber,
    sessionCount: pending.sessionCount,
  };
}

function unscheduledReasonFor(pending: PendingSession): string {
  const a = pending.assignment;
  return pending.isExplicitOverride
    ? `No valid day remains for the overridden shift ${pending.preferredShift.name} (${pending.preferredShift.startTime}-${pending.preferredShift.endTime}) without conflicting with an existing booking.`
    : pending.lecturerRestricted
      ? `Lecturer only available ${formatAvailabilityRules(a.lecturerAvailability)} — no open slot within those.`
      : `No valid day/shift combination remains for this session — tried all ${pending.shiftOrder.length} shift(s) across all ${pending.validDays.length} valid day(s) for this class's study mode, including a backtracking search that tried relocating other sessions to make room, without finding one free of conflicts.`;
}

function unscheduledItemFor(pending: PendingSession): UnscheduledItem {
  const a = pending.assignment;
  return {
    assignmentId: a.assignmentId,
    classId: a.classId,
    className: a.className,
    courseName: a.courseName,
    lecturerName: a.lecturerName,
    lecturerAvailability: a.lecturerAvailability,
    reason: unscheduledReasonFor(pending),
    shiftId: pending.preferredShift.id,
    shiftName: pending.preferredShift.name,
    sessionNumber: pending.sessionNumber,
    sessionCount: pending.sessionCount,
  };
}

export interface BacktrackingOptions {
  // Wall-clock budget for the WHOLE batch's backtracking repair (Phase
  // 2) — Phase 1's own greedy pass is always fast and unaffected by this.
  // Once exceeded, whatever's still unresolved simply stays Unscheduled,
  // exactly as if backtracking had never run — a timeout only ever means
  // "slightly fewer sessions rescued," never an incorrect placement.
  timeBudgetMs?: number;
  // How many OTHER already-placed sessions can be bumped-and-relocated in
  // a single chain while trying to seat one Unscheduled session. Bounds
  // the cost of any one repair attempt independent of the time budget.
  maxDisplacementDepth?: number;
  // Injectable clock, for deterministic tests.
  now?: () => number;
}

const DEFAULT_TIME_BUDGET_MS = 8000;
const DEFAULT_MAX_DISPLACEMENT_DEPTH = 2;
// A secondary, timing-independent safety net — bounds the total number of
// candidate slots the search examines regardless of how generous the time
// budget is, so a pathological case can't spin through millions of
// candidate checks just because the wall clock hasn't run out yet.
const DEFAULT_MAX_ATTEMPTS = 5000;

interface RepairContext {
  placed: Map<string, PlacedRecord>;
  existingCandidates: ConflictCandidateSlot[];
  deadline: number;
  now: () => number;
  maxDepth: number;
  attempts: { count: number; max: number };
  nextKeySeq: { value: number };
}

function currentCandidates(ctx: RepairContext): ConflictCandidateSlot[] {
  const batch: ConflictCandidateSlot[] = [];
  for (const [key, record] of ctx.placed) batch.push(sessionAsCandidate(record.session, key));
  return [...ctx.existingCandidates, ...batch];
}

// Tries to seat `pending` right now — first at a genuinely free slot,
// then (if none exists and `depth < ctx.maxDepth`) by displacing exactly
// one already-placed BATCH session that's the sole blocker of a candidate
// slot and recursively finding IT a new home. Pre-existing DB rows
// (`existingCandidates`) are never eligible to be displaced — only
// sessions placed earlier in this same batch (`ctx.placed`, keyed
// "batch:N") can be. Every attempted slot still goes through the exact
// same `findTimetableConflicts`/`isShiftAllowedForLecturerOnDay` checks as
// Phase 1 — this never relaxes a hard rule, it only searches harder for a
// VALID placement. Mutates `ctx.placed` in place on success (both for
// `pending` itself and for any session it had to displace); reverts any
// tentative displacement that didn't pan out before returning null.
function tryResolve(
  pending: PendingSession,
  ctx: RepairContext,
  depth: number,
  excludeKeys: ReadonlySet<string>,
  // (day, shift) pairs an ANCESTOR call in this same displacement chain
  // has already claimed for itself — see findFirstOpenSlot's avoidSlots
  // doc comment. Without this, a bumped session could "relocate" straight
  // back into the exact slot being freed up for it (that slot looks
  // conflict-free the instant its previous occupant is tentatively
  // removed), silently double-booking the room/lecturer/class instead of
  // genuinely moving elsewhere.
  reservedSlots: ReadonlySet<string>
): { day: DayOfWeek; shift: ShiftTemplate } | null {
  if (ctx.now() > ctx.deadline || ctx.attempts.count >= ctx.attempts.max) return null;

  const free = findFirstOpenSlot(
    pending.shiftOrder,
    pending.validDays,
    new Set(),
    false,
    pending.baseInput,
    currentCandidates(ctx),
    pending.assignment.lecturerAvailability,
    reservedSlots
  );
  if (free) return free;

  if (depth >= ctx.maxDepth) return null;

  for (const shift of pending.shiftOrder) {
    for (const day of pending.validDays) {
      if (ctx.now() > ctx.deadline || ctx.attempts.count >= ctx.attempts.max) return null;
      const slotKey = `${day}:${shift.id}`;
      if (reservedSlots.has(slotKey)) continue; // claimed by an ancestor already — not actually available to us
      if (!isShiftAllowedForLecturerOnDay(day, shift.id, pending.assignment.lecturerAvailability)) continue;
      ctx.attempts.count++;
      const conflicts = findTimetableConflicts(
        {
          dayOfWeek: day,
          startTime: shift.startTime,
          endTime: shift.endTime,
          roomId: pending.baseInput.roomId,
          lecturerId: pending.baseInput.lecturerId,
          classId: pending.baseInput.classId,
        },
        currentCandidates(ctx)
      );
      if (conflicts.length === 0) continue; // would already have been found by findFirstOpenSlot above

      const blockingIds = new Set(conflicts.map((c) => c.slot.id));
      if (blockingIds.size !== 1) continue; // more than one distinct blocker — too complex to displace cleanly
      const blockingKey = [...blockingIds][0];
      if (!blockingKey.startsWith("batch:") || excludeKeys.has(blockingKey)) continue;
      const blockingRecord = ctx.placed.get(blockingKey);
      if (!blockingRecord) continue;

      ctx.placed.delete(blockingKey);
      const relocated = tryResolve(
        blockingRecord.pending,
        ctx,
        depth + 1,
        new Set([...excludeKeys, blockingKey]),
        new Set([...reservedSlots, slotKey])
      );
      if (relocated) {
        const newSession = sessionFromPlacement(blockingRecord.pending, relocated.day, relocated.shift);
        const newKey = `batch:${ctx.nextKeySeq.value++}`;
        ctx.placed.set(newKey, { pending: blockingRecord.pending, session: newSession });
        return { day, shift };
      }
      // Revert — this candidate slot didn't work out.
      ctx.placed.set(blockingKey, blockingRecord);
    }
  }
  return null;
}

// Phase 2 — bounded backtracking repair over whatever Phase 1 left
// Unscheduled. Processes them in their original (deterministic) order;
// each successful repair may also relocate one or more OTHER already-
// placed sessions in a chain (see tryResolve) — those get their own
// fallback note too, since their slot changed from what Phase 1 originally
// gave them. Stops the moment the time budget or the attempt ceiling is
// hit, leaving anything not yet tried genuinely Unscheduled — never a
// partial/unsafe placement.
function runBacktrackingRepair(
  pendingUnresolved: PendingSession[],
  placed: Map<string, PlacedRecord>,
  existingCandidates: ConflictCandidateSlot[],
  options: Required<BacktrackingOptions>,
  initialKeySeq: number
): { extraFallbackNotes: FallbackNote[]; stillUnresolved: PendingSession[]; stats: BacktrackingStats } {
  const start = options.now();
  const deadline = start + options.timeBudgetMs;
  const ctx: RepairContext = {
    placed,
    existingCandidates,
    deadline,
    now: options.now,
    maxDepth: options.maxDisplacementDepth,
    attempts: { count: 0, max: DEFAULT_MAX_ATTEMPTS },
    nextKeySeq: { value: initialKeySeq },
  };

  const extraFallbackNotes: FallbackNote[] = [];
  const stillUnresolved: PendingSession[] = [];
  let resolvedCount = 0;
  let timedOut = false;

  for (const pending of pendingUnresolved) {
    if (ctx.now() > ctx.deadline || ctx.attempts.count >= ctx.attempts.max) {
      if (ctx.now() > ctx.deadline) timedOut = true;
      stillUnresolved.push(pending);
      continue;
    }

    const before = new Map<PendingSession, ScheduledSession>();
    for (const record of placed.values()) before.set(record.pending, record.session);

    const result = tryResolve(pending, ctx, 0, new Set(), new Set());
    if (!result) {
      stillUnresolved.push(pending);
      continue;
    }

    const newSession = sessionFromPlacement(pending, result.day, result.shift);
    const newKey = `batch:${ctx.nextKeySeq.value++}`;
    placed.set(newKey, { pending, session: newSession });
    resolvedCount++;

    extraFallbackNotes.push({
      assignmentId: pending.assignment.assignmentId,
      className: pending.assignment.className,
      courseName: pending.assignment.courseName,
      message: `Note: ${pending.assignment.courseName} placed on ${newSession.dayOfWeek} ${newSession.startTime}-${newSession.endTime} for ${pending.assignment.className} via a backtracking search — review recommended.`,
    });

    // Anything ELSE that changed slot (displaced-and-relocated to make
    // room for the session above) gets its own note.
    for (const [otherPending, oldSession] of before) {
      const now_ = [...placed.values()].find((r) => r.pending === otherPending);
      if (!now_ || now_.session === oldSession) continue;
      extraFallbackNotes.push({
        assignmentId: otherPending.assignment.assignmentId,
        className: otherPending.assignment.className,
        courseName: otherPending.assignment.courseName,
        message: `Note: ${otherPending.assignment.courseName} was moved from ${oldSession.dayOfWeek} ${oldSession.startTime}-${oldSession.endTime} to ${now_.session.dayOfWeek} ${now_.session.startTime}-${now_.session.endTime} by the backtracking search, to make room for another session — review recommended.`,
      });
    }
  }

  return {
    extraFallbackNotes,
    stillUnresolved,
    stats: {
      attempted: pendingUnresolved.length,
      resolved: resolvedCount,
      timedOut,
      elapsedMs: options.now() - start,
    },
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
// PHASE 1 — the original two-pass greedy placement per session,
// implementing the spacing rule (default) and its fallback (last resort)
// exactly — each pass searches the FULL (shift × day) cross-product, not
// just the one shift the credit-hour combo happened to prefer (the BUG 1
// fix):
//   Pass 1 — only days NOT yet used by this same assignment, tried across
//   every available shift (preferred one first). Encodes "never schedule
//   the same course/lecturer twice on a day if any other valid day still
//   has room."
//   Pass 2 — only reached if pass 1 placed nothing anywhere: every valid
//   day, including ones already used by this assignment, again across
//   every available shift.
// An explicit per-assignment shift OVERRIDE (an admin's deliberate choice,
// not the algorithm's own pick) is exempt from trying other shifts — it's
// tried at its own exact shift only, since silently substituting a
// different one would contradict what was explicitly requested; it still
// participates in Phase 2 below at that same fixed shift.
//
// PHASE 2 — bounded backtracking repair (see runBacktrackingRepair):
// anything Phase 1 couldn't place is retried, this time allowed to bump
// ONE already-placed batch session (recursively, up to
// `maxDisplacementDepth`) out of a conflicting slot and find IT a new
// home, before giving up. Every attempted placement — original or
// displaced — still goes through the exact same hard-conflict and
// period/day/shift-restriction checks as Phase 1; nothing is ever
// force-placed or relaxed. Bounded by a wall-clock time budget (default
// 8s) so a genuinely over-constrained batch reports final results instead
// of searching indefinitely. Only after BOTH phases give up on a session
// does it land in `unscheduled`, with its specific reason — backtracking
// shrinks that list, it doesn't remove the concept of it.
export function generateTimetableForBatch(
  assignments: AssignmentToSchedule[],
  shiftsByStudyMode: Map<StudyMode, ShiftTemplate[]>,
  existingCandidates: ConflictCandidateSlot[],
  options: BacktrackingOptions = {}
): GenerationResult {
  const resolvedOptions: Required<BacktrackingOptions> = {
    timeBudgetMs: options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS,
    maxDisplacementDepth: options.maxDisplacementDepth ?? DEFAULT_MAX_DISPLACEMENT_DEPTH,
    now: options.now ?? (() => Date.now()),
  };

  const unscheduled: UnscheduledItem[] = [];
  const comboWarnings: ComboWarning[] = [];
  const placed = new Map<string, PlacedRecord>();
  const pendingUnresolved: PendingSession[] = [];
  const phase1FallbackNotes: FallbackNote[] = [];
  // Every session's PendingSession descriptor, in original processing
  // order — whether Phase 1 placed it or not — so the final pass below can
  // walk them all in a stable order to build scheduledNormally/
  // scheduledWithFallback/unscheduled.
  const outcomeOrder: PendingSession[] = [];
  // The session Phase 1 itself placed each pending at, keyed by reference
  // — used at the end to tell "Phase 1 placed it and Phase 2 never
  // touched it" apart from "Phase 2 relocated it," without any fragile
  // name-based matching.
  const phase1PlacedSession = new Map<PendingSession, ScheduledSession>();
  const phase1UsedFallback = new Set<PendingSession>();
  let placedKeySeq = 0;

  const sorted = [...assignments].sort(
    (a, b) => a.className.localeCompare(b.className) || a.courseName.localeCompare(b.courseName)
  );

  for (const a of sorted) {
    const classValidDays = getValidDaysForStudyMode(a.studyMode) ?? ALL_DAYS_ORDER;
    // HARD constraint, applied on top of the class's own FT/PT + Period
    // valid-day rules — never relaxed by Phase 1's Pass 2 or by Phase 2's
    // backtracking below (every search only ever looks within
    // `validDays`, plus a per-(day,shift) check for any shift-restricted
    // day). An unrestricted lecturer (empty lecturerAvailability) gets
    // classValidDays back unchanged.
    const validDays = restrictedDaysForLecturer(classValidDays, a.lecturerAvailability);
    const lecturerRestricted = a.lecturerAvailability.length > 0;

    // If the restriction leaves NO valid day at all, this assignment can
    // never be scheduled regardless of room/shift/backtracking — report it
    // once for the whole assignment, before any shift-combo work.
    if (lecturerRestricted && validDays.length === 0) {
      unscheduled.push({
        assignmentId: a.assignmentId,
        classId: a.classId,
        className: a.className,
        courseName: a.courseName,
        lecturerName: a.lecturerName,
        lecturerAvailability: a.lecturerAvailability,
        reason: `Lecturer only available ${formatAvailabilityRules(a.lecturerAvailability)} — none of those day(s) are valid teaching days for this class.`,
        shiftId: "",
        shiftName: "",
        sessionNumber: 1,
        sessionCount: 1,
      });
      continue;
    }

    const shiftsForModeAll = a.studyMode ? (shiftsByStudyMode.get(a.studyMode) ?? []) : [];
    // Period restriction is FT-only — see the schema/business-rule notes
    // above generateTimetableForBatch's declaration.
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
          lecturerAvailability: a.lecturerAvailability,
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
      const candidates = [
        ...existingCandidates,
        ...[...placed.entries()].map(([key, r]) => sessionAsCandidate(r.session, key)),
      ];

      const pending: PendingSession = {
        assignment: a,
        sessionNumber,
        sessionCount,
        preferredShift,
        shiftOrder,
        validDays,
        isExplicitOverride,
        lecturerRestricted,
        baseInput,
      };
      outcomeOrder.push(pending);

      // Pass 1 — unused days, every shift.
      let placement = findFirstOpenSlot(
        shiftOrder,
        validDays,
        usedDaysForAssignment,
        true,
        baseInput,
        candidates,
        a.lecturerAvailability
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
          candidates,
          a.lecturerAvailability
        );
        usedFallback = placement !== null;
      }

      if (!placement) {
        pendingUnresolved.push(pending);
        continue;
      }

      const { day: placedDay, shift: placedShift } = placement;
      usedDaysForAssignment.add(placedDay);
      const session = sessionFromPlacement(pending, placedDay, placedShift);
      placed.set(`batch:${placedKeySeq++}`, { pending, session });
      phase1PlacedSession.set(pending, session);

      if (usedFallback) {
        phase1UsedFallback.add(pending);
        phase1FallbackNotes.push({
          assignmentId: a.assignmentId,
          className: a.className,
          courseName: a.courseName,
          message: `Note: ${a.courseName} double-booked on ${placedDay} for ${a.className} because no other valid day had room — review recommended.`,
        });
      }
    }
  }

  // ---- Phase 2: bounded backtracking repair over whatever Phase 1 left unresolved ----
  const repair = runBacktrackingRepair(
    pendingUnresolved,
    placed,
    existingCandidates,
    resolvedOptions,
    placedKeySeq
  );

  const finalByPending = new Map<PendingSession, ScheduledSession>();
  for (const record of placed.values()) finalByPending.set(record.pending, record.session);

  const scheduledNormally: ScheduledSession[] = [];
  const scheduledWithFallback: ScheduledSession[] = [];
  const fallbackNotes: FallbackNote[] = [...phase1FallbackNotes, ...repair.extraFallbackNotes];

  for (const pending of outcomeOrder) {
    const final = finalByPending.get(pending);
    if (!final) {
      unscheduled.push(unscheduledItemFor(pending));
      continue;
    }
    const phase1Session = phase1PlacedSession.get(pending);
    // Untouched by Phase 2 iff Phase 1 placed it AND the final session is
    // the EXACT SAME object Phase 1 created — Phase 2 only ever mutates
    // `placed` by deleting an old entry and inserting a brand-new session
    // object when it relocates something, so reference equality is a
    // reliable "did backtracking touch this" signal.
    if (phase1Session && phase1Session === final) {
      if (phase1UsedFallback.has(pending)) scheduledWithFallback.push(final);
      else scheduledNormally.push(final);
    } else {
      // Either Phase 1 never placed it at all (it was in
      // pendingUnresolved, so Phase 2 is the only reason it's here), or
      // Phase 2 relocated it away from its original Phase-1 slot — either
      // way, backtracking touched it, so it's flagged for review.
      scheduledWithFallback.push(final);
    }
  }

  return {
    scheduledNormally,
    scheduledWithFallback,
    fallbackNotes,
    unscheduled,
    comboWarnings,
    backtrackingStats: repair.stats,
  };
}

// ============================================================
// Pre-generation feasibility validation — computed BEFORE the scheduler
// ever runs, so an impossible workload (a lecturer with more required
// session time than their availability could ever physically fit) is
// reported as one clear, actionable warning instead of a pile of
// Unscheduled results after the fact. Pure and DB-free, like everything
// else in this file — the caller (today, the auto-generate wizard client,
// entirely client-side against data it already has) supplies the same
// AssignmentToSchedule[] + shiftsByStudyMode it would pass to
// generateTimetableForBatch.
// ============================================================

export interface FeasibilityDayBreakdown {
  dayOfWeek: DayOfWeek;
  shiftCount: number;
  hours: number;
}

export interface FeasibilityCourseBreakdown {
  assignmentId: string;
  courseName: string;
  className: string;
  hours: number;
}

export interface LecturerFeasibility {
  lecturerId: string;
  lecturerName: string;
  requiredHours: number;
  availableHours: number;
  feasible: boolean;
  // Only the days contributing at least one available slot, in
  // Saturday-first display order — an unrestricted lecturer (no
  // LecturerAvailability rows at all) gets one entry per valid teaching
  // day of every study mode/period their assignments actually use.
  availableBreakdown: FeasibilityDayBreakdown[];
  requiredBreakdown: FeasibilityCourseBreakdown[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// The real shift catalog THIS assignment's sessions would ever draw from —
// same filtering generateTimetableForBatch itself applies (FT narrowed to
// the class's own period; PT unfiltered).
function shiftsForAssignment(
  a: AssignmentToSchedule,
  shiftsByStudyMode: Map<StudyMode, ShiftTemplate[]>
): ShiftTemplate[] {
  const all = a.studyMode ? (shiftsByStudyMode.get(a.studyMode) ?? []) : [];
  return a.studyMode === "FT" ? all.filter((s) => s.period === a.period) : all;
}

// Groups `assignments` by lecturer and, for each one, compares their TOTAL
// available teaching time (every distinct (day, shift) slot usable by AT
// LEAST ONE of their own assignments in this batch — unrestricted days/
// shifts if they have no LecturerAvailability rows at all) against their
// TOTAL required session time (the real scheduled duration per
// assignment — an explicit shift override's own total, or
// findClosestShiftCombo's totalHours, never the raw requested creditHours
// number, which can legitimately differ once rounded to whole shifts).
// Returns EVERY lecturer in the batch, feasible or not — the caller
// filters to `!feasible` for the actual warning list.
export function checkBatchFeasibility(
  assignments: AssignmentToSchedule[],
  shiftsByStudyMode: Map<StudyMode, ShiftTemplate[]>
): LecturerFeasibility[] {
  const byLecturer = new Map<string, AssignmentToSchedule[]>();
  for (const a of assignments) {
    const list = byLecturer.get(a.lecturerId) ?? [];
    list.push(a);
    byLecturer.set(a.lecturerId, list);
  }

  const results: LecturerFeasibility[] = [];
  for (const [lecturerId, lecturerAssignments] of byLecturer) {
    const lecturerName = lecturerAssignments[0].lecturerName;
    // Every assignment for one lecturer shares the same availability rule
    // set (it's a property of the Lecturer, not the assignment).
    const lecturerAvailability = lecturerAssignments[0].lecturerAvailability;

    const availableSlots = new Map<string, { day: DayOfWeek; shift: ShiftTemplate }>();
    for (const a of lecturerAssignments) {
      const classValidDays = getValidDaysForStudyMode(a.studyMode) ?? ALL_DAYS_ORDER;
      const days = restrictedDaysForLecturer(classValidDays, lecturerAvailability);
      const relevantShifts = shiftsForAssignment(a, shiftsByStudyMode);
      for (const day of days) {
        for (const shift of relevantShifts) {
          if (!isShiftAllowedForLecturerOnDay(day, shift.id, lecturerAvailability)) continue;
          availableSlots.set(`${day}:${shift.id}`, { day, shift });
        }
      }
    }
    const availableByDay = new Map<DayOfWeek, { count: number; hours: number }>();
    for (const { day, shift } of availableSlots.values()) {
      const entry = availableByDay.get(day) ?? { count: 0, hours: 0 };
      entry.count += 1;
      entry.hours += shiftHours(shift);
      availableByDay.set(day, entry);
    }
    const availableBreakdown: FeasibilityDayBreakdown[] = ALL_DAYS_ORDER.filter((d) =>
      availableByDay.has(d)
    ).map((d) => {
      const entry = availableByDay.get(d)!;
      return { dayOfWeek: d, shiftCount: entry.count, hours: round2(entry.hours) };
    });
    const availableHours = round2(availableBreakdown.reduce((sum, b) => sum + b.hours, 0));

    const requiredBreakdown: FeasibilityCourseBreakdown[] = [];
    for (const a of lecturerAssignments) {
      const relevantShifts = shiftsForAssignment(a, shiftsByStudyMode);
      let hours: number | null = null;
      if (a.shiftOverrideIds && a.shiftOverrideIds.length > 0) {
        const chosen = a.shiftOverrideIds
          .map((id) => relevantShifts.find((s) => s.id === id))
          .filter((s): s is ShiftTemplate => Boolean(s));
        if (chosen.length > 0) hours = chosen.reduce((sum, s) => sum + shiftHours(s), 0);
      } else {
        const combo = findClosestShiftCombo(a.creditHours, relevantShifts);
        if (combo) hours = combo.totalHours;
      }
      // No shift templates at all for this assignment's study mode/period —
      // reported separately once generation actually runs ("No Shift
      // templates exist..."); not counted here to avoid double-flagging
      // the same root cause two different ways.
      if (hours === null) continue;
      requiredBreakdown.push({
        assignmentId: a.assignmentId,
        courseName: a.courseName,
        className: a.className,
        hours: round2(hours),
      });
    }
    const requiredHours = round2(requiredBreakdown.reduce((sum, b) => sum + b.hours, 0));

    results.push({
      lecturerId,
      lecturerName,
      requiredHours,
      availableHours,
      feasible: requiredHours <= availableHours + EPSILON,
      availableBreakdown,
      requiredBreakdown,
    });
  }

  return results.sort((a, b) => a.lecturerName.localeCompare(b.lecturerName));
}

// The clear, actionable, "show the actual math" message this feature was
// built for — reused verbatim by the wizard's feasibility-warning step so
// its wording can never drift from what checkBatchFeasibility computed.
export function formatFeasibilityMessage(check: LecturerFeasibility): string {
  const availText =
    check.availableBreakdown.length > 0
      ? check.availableBreakdown
          .map(
            (b) =>
              `${DAY_SHORT_LABELS[b.dayOfWeek]}: ${b.shiftCount} shift${b.shiftCount === 1 ? "" : "s"} = ${b.hours}h`
          )
          .join(", ")
      : "no available days/shifts at all";
  return `Lecturer ${check.lecturerName} needs ${check.requiredHours}h of sessions but their availability only allows ${check.availableHours}h (${availText}). Reduce their workload, add more available days/shifts, or reassign some courses to another lecturer before generating.`;
}

// Reusable by both the server (loadShiftsByStudyMode) and the client
// (the wizard's feasibility check, run against the same `shifts` prop it
// already has) — so the two can never disagree about how shifts group by
// study mode.
export function buildShiftsByStudyMode(shifts: ShiftTemplate[]): Map<StudyMode, ShiftTemplate[]> {
  const map = new Map<StudyMode, ShiftTemplate[]>();
  for (const s of shifts) {
    const list = map.get(s.studyMode) ?? [];
    list.push(s);
    map.set(s.studyMode, list);
  }
  return map;
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
