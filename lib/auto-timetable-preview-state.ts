import type { DayOfWeek } from "@prisma/client";
import { findTimetableConflicts, type ConflictCandidateSlot, type TimetableConflict } from "./timetable-conflicts";
import type { ScheduledSession, UnscheduledItem } from "./auto-timetable";

// Pure, DB-free local-editing model for the auto-timetable generator's
// multi-class preview overview (see CLAUDE.md's "Workload Excel import +
// auto-timetable generation" business rule — the multi-class overview +
// per-class fullscreen drag-and-drop review). A fresh server-generated
// GenerationResult (lib/auto-timetable.ts) is reshaped once, per class,
// into an editable ClassPreviewState; every subsequent drag/move/
// unschedule/edit the admin makes in the overview or a class's fullscreen
// modal goes through the pure functions below and never mutates the
// original result. Nothing here writes to the DB — the whole point is
// that this state stays LOCAL until "Build all" flattens it into the
// exact `sessions` shape confirmAutoTimetableBatch expects.

export interface PreviewAssignmentMeta {
  assignmentId: string;
  classId: string;
  className: string;
  courseName: string;
  lecturerId: string;
  lecturerName: string;
  // OPTIONAL hard scheduling constraint (see Lecturer.availableDays) —
  // carried through to the resulting PreviewSession when a chip is
  // scheduled (scheduleChipInClass), since a chip itself has no lecturerId
  // to look this up from. Empty = unrestricted.
  lecturerAvailableDays: DayOfWeek[];
  // The class's own default room (Class.roomId) — the only room a
  // currently-unscheduled chip can be placed into, matching the
  // "room is a class-registration property" rule everywhere else in this
  // app. Once placed, a session's room can still be edited (an override,
  // same as the manual Build Timetable grid's per-session affordance) via
  // editSessionRoomInClass.
  roomId: string;
  roomLabel: string;
}

export interface PreviewSession {
  id: string;
  assignmentId: string;
  classId: string;
  courseName: string;
  lecturerId: string;
  lecturerName: string;
  // OPTIONAL hard scheduling constraint (see Lecturer.availableDays) —
  // empty = unrestricted, exactly today's behavior. Consumed by
  // components/timetable/schedule-grid.tsx to grey out/block
  // non-available days while THIS session is being dragged.
  lecturerAvailableDays: DayOfWeek[];
  roomId: string;
  roomLabel: string;
  dayOfWeek: DayOfWeek;
  startTime: string;
  endTime: string;
  sessionNumber: number;
  sessionCount: number;
  // True only for a session the ALGORITHM placed via the spacing fallback
  // (see generateTimetableForBatch) — cleared the moment the admin
  // deliberately moves/retimes/re-rooms it, since a manual placement is no
  // longer the algorithm's own fallback choice.
  flagged: boolean;
  // Manual, per-session, opt-in exception ONLY — true means this ONE
  // session deliberately uses a shift from the OTHER period than its
  // class's own (see CLAUDE.md's "Period" business rule's "cross-period
  // override" bullet). The algorithm never sets this (buildPreviewStateByClass
  // always seeds it false); it's derived fresh on every
  // schedule/move from whichever row (own-period or cross-period) the
  // session lands on — see scheduleChipInClass/moveSessionInClass.
  crossPeriodOverride: boolean;
}

export interface PreviewChip {
  id: string;
  assignmentId: string;
  classId: string;
  courseName: string;
  lecturerName: string;
  // Same optional hard constraint as PreviewSession — carried through so
  // dragging an unscheduled CHIP also greys out/blocks the same
  // non-available days a placed session would.
  lecturerAvailableDays: DayOfWeek[];
  sessionNumber: number;
  sessionCount: number;
  // Why it's unscheduled — either the algorithm's own reason (from
  // UnscheduledItem.reason) or "Manually unscheduled." after the admin
  // drags a placed session onto the trash zone.
  reason: string;
}

export interface ClassPreviewState {
  classId: string;
  className: string;
  sessions: PreviewSession[];
  chips: PreviewChip[];
}

function makeSessionId(assignmentId: string, sessionNumber: number): string {
  return `${assignmentId}:${sessionNumber}`;
}

// Builds one ClassPreviewState per class straight from a fresh
// GenerationResult — the starting point before any local edit. Every
// scheduled/fallback session already carries everything it needs
// (lecturerId/roomId/roomName are on ScheduledSession itself); only a
// CHIP (an unscheduled item) lacks room/lecturerId, since those only
// matter once it's actually placed — see scheduleChipInClass.
export function buildPreviewStateByClass(result: {
  scheduledNormally: ScheduledSession[];
  scheduledWithFallback: ScheduledSession[];
  unscheduled: UnscheduledItem[];
}): Map<string, ClassPreviewState> {
  const byClass = new Map<string, ClassPreviewState>();

  function ensure(classId: string, className: string): ClassPreviewState {
    let cls = byClass.get(classId);
    if (!cls) {
      cls = { classId, className, sessions: [], chips: [] };
      byClass.set(classId, cls);
    }
    return cls;
  }

  function pushSession(s: ScheduledSession, flagged: boolean) {
    const cls = ensure(s.classId, s.className);
    cls.sessions.push({
      id: makeSessionId(s.assignmentId, s.sessionNumber),
      assignmentId: s.assignmentId,
      classId: s.classId,
      courseName: s.courseName,
      lecturerId: s.lecturerId,
      lecturerName: s.lecturerName,
      lecturerAvailableDays: s.lecturerAvailableDays,
      roomId: s.roomId,
      roomLabel: s.roomName,
      dayOfWeek: s.dayOfWeek,
      startTime: s.startTime,
      endTime: s.endTime,
      sessionNumber: s.sessionNumber,
      sessionCount: s.sessionCount,
      flagged,
      // Never true here — lib/auto-timetable.ts's generateTimetableForBatch
      // has no code path that could set this; ScheduledSession itself
      // carries no such field. Cross-period placement is manual-only.
      crossPeriodOverride: false,
    });
  }

  for (const s of result.scheduledNormally) pushSession(s, false);
  for (const s of result.scheduledWithFallback) pushSession(s, true);

  for (const u of result.unscheduled) {
    const cls = ensure(u.classId, u.className);
    cls.chips.push({
      id: makeSessionId(u.assignmentId, u.sessionNumber),
      assignmentId: u.assignmentId,
      classId: u.classId,
      courseName: u.courseName,
      lecturerName: u.lecturerName,
      lecturerAvailableDays: u.lecturerAvailableDays,
      sessionNumber: u.sessionNumber,
      sessionCount: u.sessionCount,
      reason: u.reason,
    });
  }

  return byClass;
}

function sessionAsConflictCandidate(cls: ClassPreviewState, session: PreviewSession): ConflictCandidateSlot {
  return {
    id: session.id,
    dayOfWeek: session.dayOfWeek,
    startTime: session.startTime,
    endTime: session.endTime,
    roomId: session.roomId,
    roomName: session.roomLabel,
    lecturerId: session.lecturerId,
    lecturerName: session.lecturerName,
    classId: session.classId,
    className: cls.className,
    courseName: session.courseName,
  };
}

// Every OTHER session already placed in this same class — used as part of
// the candidate list for an edit within that class, so a session never
// conflicts with itself (excludeSessionId) but still correctly conflicts
// with its own classmates (e.g. two sessions of the same class overlapping
// in time, a CLASS conflict).
function ownSessionsAsCandidates(cls: ClassPreviewState, excludeSessionId?: string): ConflictCandidateSlot[] {
  return cls.sessions.filter((s) => s.id !== excludeSessionId).map((s) => sessionAsConflictCandidate(cls, s));
}

// Every currently-scheduled session in this class, as conflict candidates
// — used by the overview to build the "other classes" candidate list a
// fullscreen modal checks against (room/lecturer conflicts can span
// classes; a class's own sessions are excluded there and handled via
// ownSessionsAsCandidates instead).
export function classSessionsAsConflictCandidates(cls: ClassPreviewState): ConflictCandidateSlot[] {
  return cls.sessions.map((s) => sessionAsConflictCandidate(cls, s));
}

export function otherClassesAsConflictCandidates(
  stateByClass: Map<string, ClassPreviewState>,
  excludeClassId: string
): ConflictCandidateSlot[] {
  const out: ConflictCandidateSlot[] = [];
  for (const cls of stateByClass.values()) {
    if (cls.classId === excludeClassId) continue;
    out.push(...classSessionsAsConflictCandidates(cls));
  }
  return out;
}

export interface PreviewRow {
  id: string;
  startTime: string;
  endTime: string;
  // True for a row representing the OTHER period's shift (only ever
  // offered/shown by the caller when the class is FT with a period set —
  // see ScheduleGridRow.crossPeriod). Scheduling/moving a session onto
  // such a row is what marks it PreviewSession.crossPeriodOverride; moving
  // it back onto a normal (own-period) row clears the flag again — the
  // flag always reflects CURRENT placement, not a separately-tracked
  // intent.
  crossPeriod?: boolean;
}

export interface PreviewOpResult {
  ok: boolean;
  cls: ClassPreviewState; // updated on success; the original, unchanged on failure
  conflicts?: TimetableConflict[];
}

// Promotes a currently-unscheduled chip into a placed session at
// (day, row) — the drag-a-chip-onto-a-cell action. `meta` supplies the
// lecturer/room identity the chip itself doesn't carry (see
// PreviewChip's own doc comment).
export function scheduleChipInClass(
  cls: ClassPreviewState,
  chipId: string,
  day: DayOfWeek,
  row: PreviewRow,
  meta: PreviewAssignmentMeta,
  externalCandidates: ConflictCandidateSlot[]
): PreviewOpResult {
  const chip = cls.chips.find((c) => c.id === chipId);
  if (!chip) return { ok: false, cls };

  const conflicts = findTimetableConflicts(
    { dayOfWeek: day, startTime: row.startTime, endTime: row.endTime, roomId: meta.roomId, lecturerId: meta.lecturerId, classId: cls.classId },
    [...externalCandidates, ...ownSessionsAsCandidates(cls)]
  );
  if (conflicts.length > 0) return { ok: false, cls, conflicts };

  const session: PreviewSession = {
    id: chip.id,
    assignmentId: chip.assignmentId,
    classId: cls.classId,
    courseName: chip.courseName,
    lecturerId: meta.lecturerId,
    lecturerName: chip.lecturerName,
    lecturerAvailableDays: meta.lecturerAvailableDays,
    roomId: meta.roomId,
    roomLabel: meta.roomLabel,
    dayOfWeek: day,
    startTime: row.startTime,
    endTime: row.endTime,
    sessionNumber: chip.sessionNumber,
    sessionCount: chip.sessionCount,
    flagged: false,
    crossPeriodOverride: !!row.crossPeriod,
  };

  return {
    ok: true,
    cls: { ...cls, sessions: [...cls.sessions, session], chips: cls.chips.filter((c) => c.id !== chipId) },
  };
}

// Moves an already-placed session to a different (day, row) — dragging a
// placed card onto a different cell.
export function moveSessionInClass(
  cls: ClassPreviewState,
  sessionId: string,
  day: DayOfWeek,
  row: PreviewRow,
  externalCandidates: ConflictCandidateSlot[]
): PreviewOpResult {
  const session = cls.sessions.find((s) => s.id === sessionId);
  if (!session) return { ok: false, cls };

  const conflicts = findTimetableConflicts(
    { dayOfWeek: day, startTime: row.startTime, endTime: row.endTime, roomId: session.roomId, lecturerId: session.lecturerId, classId: cls.classId },
    [...externalCandidates, ...ownSessionsAsCandidates(cls, sessionId)]
  );
  if (conflicts.length > 0) return { ok: false, cls, conflicts };

  const updated: PreviewSession = {
    ...session,
    dayOfWeek: day,
    startTime: row.startTime,
    endTime: row.endTime,
    flagged: false,
    crossPeriodOverride: !!row.crossPeriod,
  };
  return { ok: true, cls: { ...cls, sessions: cls.sessions.map((s) => (s.id === sessionId ? updated : s)) } };
}

// Free-typed time edit on an already-placed session (the fullscreen
// modal's inline time editor, or the inline cross-period shift picker —
// see crossPeriodOverride below). A no-op patch (same start/end AND same
// crossPeriodOverride, when given) always succeeds without a conflict
// check, matching the manual builder's own updateSlot short-circuit.
export function editSessionTimeInClass(
  cls: ClassPreviewState,
  sessionId: string,
  patch: { startTime?: string; endTime?: string },
  externalCandidates: ConflictCandidateSlot[],
  // Omitted = preserve the session's current flag unchanged (a plain
  // free-text time retype never touches it). Provided = set it explicitly
  // — this is how picking a shift from the inline cross-period picker
  // both retimes AND flags the session in one call.
  crossPeriodOverride?: boolean
): PreviewOpResult {
  const session = cls.sessions.find((s) => s.id === sessionId);
  if (!session) return { ok: false, cls };
  const nextStart = patch.startTime ?? session.startTime;
  const nextEnd = patch.endTime ?? session.endTime;
  const nextCrossPeriod = crossPeriodOverride ?? session.crossPeriodOverride;
  if (nextStart === session.startTime && nextEnd === session.endTime && nextCrossPeriod === session.crossPeriodOverride) {
    return { ok: true, cls };
  }

  const conflicts = findTimetableConflicts(
    { dayOfWeek: session.dayOfWeek, startTime: nextStart, endTime: nextEnd, roomId: session.roomId, lecturerId: session.lecturerId, classId: cls.classId },
    [...externalCandidates, ...ownSessionsAsCandidates(cls, sessionId)]
  );
  if (conflicts.length > 0) return { ok: false, cls, conflicts };

  const updated: PreviewSession = {
    ...session,
    startTime: nextStart,
    endTime: nextEnd,
    flagged: false,
    crossPeriodOverride: nextCrossPeriod,
  };
  return { ok: true, cls: { ...cls, sessions: cls.sessions.map((s) => (s.id === sessionId ? updated : s)) } };
}

// Plain checkbox toggle — flips crossPeriodOverride WITHOUT touching
// day/time/room, so there is nothing new to conflict-check (the existing
// placement is already conflict-free) and this always succeeds. Used when
// an admin just wants to mark an already-placed session as a deliberate
// exception (e.g. one they've already retimed by hand) without also
// picking from the inline shift dropdown.
export function setCrossPeriodOverrideInClass(
  cls: ClassPreviewState,
  sessionId: string,
  allow: boolean
): PreviewOpResult {
  const session = cls.sessions.find((s) => s.id === sessionId);
  if (!session) return { ok: false, cls };
  if (session.crossPeriodOverride === allow) return { ok: true, cls };
  const updated: PreviewSession = { ...session, crossPeriodOverride: allow };
  return { ok: true, cls: { ...cls, sessions: cls.sessions.map((s) => (s.id === sessionId ? updated : s)) } };
}

// Room override on an already-placed session — same "different room for
// this session" exception the manual Build Timetable grid already offers.
export function editSessionRoomInClass(
  cls: ClassPreviewState,
  sessionId: string,
  roomId: string,
  roomLabel: string,
  externalCandidates: ConflictCandidateSlot[]
): PreviewOpResult {
  const session = cls.sessions.find((s) => s.id === sessionId);
  if (!session) return { ok: false, cls };
  if (roomId === session.roomId) return { ok: true, cls };

  const conflicts = findTimetableConflicts(
    { dayOfWeek: session.dayOfWeek, startTime: session.startTime, endTime: session.endTime, roomId, lecturerId: session.lecturerId, classId: cls.classId },
    [...externalCandidates, ...ownSessionsAsCandidates(cls, sessionId)]
  );
  if (conflicts.length > 0) return { ok: false, cls, conflicts };

  const updated: PreviewSession = { ...session, roomId, roomLabel };
  return { ok: true, cls: { ...cls, sessions: cls.sessions.map((s) => (s.id === sessionId ? updated : s)) } };
}

// Drops a placed session back into the unscheduled tray — dragging a
// placed card onto the trash zone. Always succeeds (there is no conflict
// to check when removing something).
export function unscheduleSessionInClass(
  cls: ClassPreviewState,
  sessionId: string,
  reason = "Manually unscheduled."
): ClassPreviewState {
  const session = cls.sessions.find((s) => s.id === sessionId);
  if (!session) return cls;
  const chip: PreviewChip = {
    id: session.id,
    assignmentId: session.assignmentId,
    classId: session.classId,
    courseName: session.courseName,
    lecturerName: session.lecturerName,
    lecturerAvailableDays: session.lecturerAvailableDays,
    sessionNumber: session.sessionNumber,
    sessionCount: session.sessionCount,
    reason,
  };
  return { ...cls, sessions: cls.sessions.filter((s) => s.id !== sessionId), chips: [...cls.chips, chip] };
}

export interface ClassPreviewCounts {
  scheduled: number;
  unscheduled: number;
  flagged: number;
}

export function classPreviewCounts(cls: ClassPreviewState): ClassPreviewCounts {
  return {
    scheduled: cls.sessions.length,
    unscheduled: cls.chips.length,
    flagged: cls.sessions.filter((s) => s.flagged).length,
  };
}

export interface CommitSession {
  assignmentId: string;
  classId: string;
  roomId: string;
  dayOfWeek: DayOfWeek;
  startTime: string;
  endTime: string;
  crossPeriodOverride: boolean;
}

// Flattens every class's currently-scheduled sessions across the whole
// batch into exactly the `sessions` shape confirmAutoTimetableBatch
// expects — this IS the "commit local preview state as real
// TimetableSlots" step ("Build all"). Unscheduled chips are never
// included; they simply stay unscheduled until placed manually later.
export function flattenSessionsForCommit(stateByClass: Map<string, ClassPreviewState>): CommitSession[] {
  const out: CommitSession[] = [];
  for (const cls of stateByClass.values()) {
    for (const s of cls.sessions) {
      out.push({
        assignmentId: s.assignmentId,
        classId: s.classId,
        roomId: s.roomId,
        dayOfWeek: s.dayOfWeek,
        startTime: s.startTime,
        endTime: s.endTime,
        crossPeriodOverride: s.crossPeriodOverride,
      });
    }
  }
  return out;
}
