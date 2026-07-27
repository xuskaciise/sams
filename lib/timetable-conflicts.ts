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

    const when = `${slot.dayOfWeek} ${slot.startTime}-${slot.endTime}`;

    if (slot.roomId === input.roomId) {
      conflicts.push({
        kind: "ROOM",
        message: `Room ${slot.roomName} is already booked for ${slot.courseName} (${slot.className}) on ${when}.`,
        slot,
      });
    }
    if (slot.lecturerId === input.lecturerId) {
      conflicts.push({
        kind: "LECTURER",
        message: `${slot.lecturerName} already teaches ${slot.courseName} (${slot.className}) on ${when}.`,
        slot,
      });
    }
    if (slot.classId === input.classId) {
      conflicts.push({
        kind: "CLASS",
        message: `${slot.className} already has ${slot.courseName} scheduled on ${when}.`,
        slot,
      });
    }
  }

  return conflicts;
}
