import type { DayOfWeek } from "@prisma/client";

// Pure, DB-free conflict detection — the caller (actions.ts for the real
// pre-check, or a live-preview action for the inline form warning) is
// responsible for fetching `candidates` already scoped to the SAME
// semester as `input` (a room/lecturer/class only conflicts with another
// booking in the same semester — reusing a Monday 9am slot across
// different semesters is normal, not a conflict) and, when editing an
// existing slot, passing its own id as `excludeSlotId` so it doesn't
// conflict with itself.
export interface ConflictCandidateSlot {
  id: string;
  dayOfWeek: DayOfWeek;
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
  roomId: string;
  roomName: string;
  lecturerId: string;
  lecturerName: string;
  classId: string;
  className: string;
  courseName: string;
}

export interface ConflictCheckInput {
  dayOfWeek: DayOfWeek;
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
  roomId: string;
  lecturerId: string;
  classId: string;
}

export type ConflictKind = "ROOM" | "LECTURER" | "CLASS";

// Prefix the timetable create/update actions put on a thrown error when
// EVERY detected conflict is a ROOM conflict — the manual clients
// (single-slot dialog, drag-and-drop grid) key on this to open an "open
// rooms for this shift" picker instead of a dead-end toast. Defined here
// (a pure module both server and client already import) so the string
// can't drift between the thrower and the checkers. lib/action-error.ts
// strips it for plain display.
export const ROOM_CONFLICT_PREFIX = "ROOM_CONFLICT::";

export function isRoomOnlyConflictError(message: string): boolean {
  return message.startsWith(ROOM_CONFLICT_PREFIX);
}

export interface TimetableConflict {
  kind: ConflictKind;
  message: string;
  slot: ConflictCandidateSlot;
}

export function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

// Any intersection of the two [start, end) ranges counts as overlapping —
// a slot ending exactly when another starts (e.g. 09:00-10:00 and
// 10:00-11:00) does NOT overlap.
export function timeRangesOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string
): boolean {
  return (
    timeToMinutes(aStart) < timeToMinutes(bEnd) &&
    timeToMinutes(bStart) < timeToMinutes(aEnd)
  );
}

function whenLabel(dayOfWeek: DayOfWeek, startTime: string, endTime: string): string {
  return `${dayOfWeek} ${startTime}-${endTime}`;
}

// The full standalone sentence for ONE conflict — states WHICH kind
// (room vs lecturer vs class) is the problem and WHY, not just what/when.
// Used verbatim as `TimetableConflict.message` (one line per conflict in
// the live inline-preview list) and as the thrown error when exactly one
// conflict blocks a placement.
export function describeConflict(kind: ConflictKind, slot: ConflictCandidateSlot): string {
  const when = whenLabel(slot.dayOfWeek, slot.startTime, slot.endTime);
  switch (kind) {
    case "ROOM":
      return `Room ${slot.roomName} is already booked for ${slot.courseName} (${slot.className}) at ${when} by a different class.`;
    case "LECTURER":
      return `This lecturer already has a session (${slot.courseName}, ${slot.className}) at ${when} — a lecturer can't teach two classes at the same time.`;
    case "CLASS":
      return `${slot.className} already has a session (${slot.courseName}) at ${when} — a class can't have two sessions at once.`;
    default:
      return `This slot conflicts with ${slot.courseName} (${slot.className}) at ${when}.`;
  }
}

// The short fragment for the combined "several conflicts at once" sentence
// (see describeConflicts) — no trailing period, no "why" clause (the
// combined header carries the shared context).
function conflictFragment(kind: ConflictKind, slot: ConflictCandidateSlot): string {
  switch (kind) {
    case "ROOM":
      return `Room ${slot.roomName} is already booked (${slot.courseName}, ${slot.className})`;
    case "LECTURER":
      return `this lecturer already has a session at that time (${slot.courseName}, ${slot.className})`;
    case "CLASS":
      return `this class already has a session at that time (${slot.courseName})`;
    default:
      return `it clashes with ${slot.courseName} (${slot.className})`;
  }
}

// The user-facing message for the whole set of conflicts blocking ONE
// placement. Exactly one conflict -> its full standalone sentence.
// Several -> a combined "This isn't schedulable at <when>: X, AND Y."
// that spells out EVERY one rather than surfacing the first and hiding
// the rest. `placement` (the day/time being scheduled) fixes the header
// "when"; falls back to the first conflict's own slot time if omitted.
export function describeConflicts(
  conflicts: TimetableConflict[],
  placement?: { dayOfWeek: DayOfWeek; startTime: string; endTime: string }
): string {
  if (conflicts.length === 0) return "";
  if (conflicts.length === 1) return describeConflict(conflicts[0].kind, conflicts[0].slot);

  const first = conflicts[0].slot;
  const when = placement
    ? whenLabel(placement.dayOfWeek, placement.startTime, placement.endTime)
    : whenLabel(first.dayOfWeek, first.startTime, first.endTime);

  const parts = conflicts.map((c) => conflictFragment(c.kind, c.slot));
  const joined =
    parts.length === 2
      ? `${parts[0]}, AND ${parts[1]}`
      : `${parts.slice(0, -1).join(", ")}, AND ${parts[parts.length - 1]}`;

  return `This isn't schedulable at ${when}: ${joined}.`;
}

// Collects EVERY conflict found (a slot can conflict on more than one
// dimension at once, e.g. same room AND same lecturer), rather than
// stopping at the first — same "report everything, don't fail on the
// first hit" convention as bulk-assign/open-semester.
export function findTimetableConflicts(
  input: ConflictCheckInput,
  candidates: ConflictCandidateSlot[],
  excludeSlotId?: string
): TimetableConflict[] {
  const conflicts: TimetableConflict[] = [];

  for (const slot of candidates) {
    if (slot.id === excludeSlotId) continue;
    if (slot.dayOfWeek !== input.dayOfWeek) continue;
    if (!timeRangesOverlap(input.startTime, input.endTime, slot.startTime, slot.endTime)) {
      continue;
    }

    if (slot.roomId === input.roomId) {
      conflicts.push({ kind: "ROOM", message: describeConflict("ROOM", slot), slot });
    }
    if (slot.lecturerId === input.lecturerId) {
      conflicts.push({ kind: "LECTURER", message: describeConflict("LECTURER", slot), slot });
    }
    if (slot.classId === input.classId) {
      conflicts.push({ kind: "CLASS", message: describeConflict("CLASS", slot), slot });
    }
  }

  return conflicts;
}

// One row of a "Build timetable" whole-week submission — a ConflictCheckInput
// plus the display fields needed so it can also act as a candidate when
// OTHER sessions in the same batch are checked against it (a batch can
// conflict with itself, e.g. two sessions in the same submission both
// booking Room X at an overlapping time, with nothing in the DB yet).
export interface WeekBuilderSession extends ConflictCheckInput {
  key: string; // client-side row id, correlates a conflict back to its UI row
  roomName: string;
  lecturerName: string;
  className: string;
  courseName: string;
}

export interface WeekBuilderConflict extends TimetableConflict {
  sessionKey: string;
}

// Checks every session in a submitted week against BOTH the existing DB
// slots for that semester AND every other session in the same batch —
// the whole point of building a week in one shot is that two of its own
// sessions can conflict with each other even though neither exists in
// the DB yet. All-or-nothing: the caller creates nothing if this returns
// anything. Reuses findTimetableConflicts per session rather than a new
// algorithm, so the underlying overlap/conflict-kind rules never drift
// between the single-slot and whole-week paths.
export function findWeekBuilderConflicts(
  sessions: WeekBuilderSession[],
  existingCandidates: ConflictCandidateSlot[]
): WeekBuilderConflict[] {
  const results: WeekBuilderConflict[] = [];

  sessions.forEach((session, i) => {
    const otherSessionsAsCandidates: ConflictCandidateSlot[] = sessions
      .filter((_, j) => j !== i)
      .map((s) => ({
        id: `batch:${s.key}`,
        dayOfWeek: s.dayOfWeek,
        startTime: s.startTime,
        endTime: s.endTime,
        roomId: s.roomId,
        roomName: s.roomName,
        lecturerId: s.lecturerId,
        lecturerName: s.lecturerName,
        classId: s.classId,
        className: s.className,
        courseName: s.courseName,
      }));

    const conflicts = findTimetableConflicts(session, [
      ...existingCandidates,
      ...otherSessionsAsCandidates,
    ]);
    for (const c of conflicts) {
      results.push({ ...c, sessionKey: session.key });
    }
  });

  return results;
}
