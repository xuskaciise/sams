import { prisma } from "@/lib/db";
import { findTimetableConflicts } from "@/lib/timetable-conflicts";
import { getConflictCandidates } from "../timetable/queries";

// ── Shared room-change conflict-check + propagation logic ─────────────
// Used by BOTH the pairwise tools in classes/actions.ts ("Change room" /
// "Swap rooms") and the batch tool in admin/room-reassignment/actions.ts
// ("Room Reassignment"). All three reduce a room change to: "would moving
// this class's existing sessions into <newRoom> collide with a booking
// that ISN'T also part of this move?" The overlap / conflict-kind
// detection itself lives entirely in lib/timetable-conflicts.ts
// (findTimetableConflicts) — this module only decides which candidates to
// check against.
//
// NOT a "use server" file on purpose: these are plain server-side helpers
// imported by the real Server Actions (which do the auth checks), not
// RPC endpoints themselves.

interface RoomClashResult {
  movedSessions: number;
  clashes: string[]; // unique, human-readable; empty => no genuine clash
}

// The ONE conflict-finder. Fetches `classId`'s TimetableSlots and, for
// each, checks its own day+time against every other slot in the same
// semester for a ROOM collision at `newRoomId`.
//
// `ignoredClassIds` — classes (besides `classId` itself) whose bookings
// don't count as a clash because they're moving too (pairwise "Swap
// rooms": the other class vacates its room in the same transaction).
//
// `finalRoomByClass` — when given, every candidate slot's room is
// rewritten to that class's FINAL room before the check, so the question
// becomes "does the FINAL state collide?" rather than "does any transient
// mid-shuffle state collide?". This is what lets the batch tool reassign
// a chain/cycle of classes without them flagging each other over rooms
// they hand off between themselves — while still catching (a) a real
// third-party booking in a target room and (b) two participants that
// would end up in the SAME room at overlapping times.
export async function findRoomClashesForClassSlots(
  classId: string,
  newRoomId: string,
  ignoredClassIds: string[] = [],
  finalRoomByClass?: Map<string, string>
): Promise<RoomClashResult> {
  const ignored = new Set<string>([classId, ...ignoredClassIds]);

  const slots = await prisma.timetableSlot.findMany({
    where: { assignment: { classId } },
    select: {
      id: true,
      dayOfWeek: true,
      startTime: true,
      endTime: true,
      assignment: { select: { semesterId: true, lecturerId: true } },
    },
  });
  if (slots.length === 0) return { movedSessions: 0, clashes: [] };

  const semesterIds = [...new Set(slots.map((s) => s.assignment.semesterId))];
  const candidatesBySemester = new Map(
    await Promise.all(
      semesterIds.map(async (sid) => {
        let candidates = await getConflictCandidates(sid);
        if (finalRoomByClass) {
          candidates = candidates.map((c) => ({
            ...c,
            roomId: finalRoomByClass.get(c.classId) ?? c.roomId,
          }));
        }
        return [sid, candidates] as const;
      })
    )
  );

  const clashes: string[] = [];
  for (const slot of slots) {
    const conflicts = findTimetableConflicts(
      {
        dayOfWeek: slot.dayOfWeek,
        startTime: slot.startTime,
        endTime: slot.endTime,
        roomId: newRoomId,
        lecturerId: slot.assignment.lecturerId,
        classId,
      },
      candidatesBySemester.get(slot.assignment.semesterId) ?? [],
      slot.id
    );
    for (const c of conflicts) {
      // A room-only change never introduces a LECTURER/CLASS conflict
      // (day/time/lecturer are untouched), so only ROOM clashes matter —
      // and only against a class that isn't part of this same move.
      if (c.kind === "ROOM" && !ignored.has(c.slot.classId)) clashes.push(c.message);
    }
  }

  return { movedSessions: slots.length, clashes: [...new Set(clashes)] };
}

// Pairwise entry point: throws (blocking the caller's whole update, no
// writes) if `newRoomId` is already booked by a class NOT in this move.
export async function checkNewRoomForClassSlots(
  classId: string,
  newRoomId: string,
  ignoredClassIds: string[] = []
): Promise<{ movedSessions: number }> {
  const { movedSessions, clashes } = await findRoomClashesForClassSlots(
    classId,
    newRoomId,
    ignoredClassIds
  );
  if (clashes.length > 0) {
    throw new Error(
      `This class's room can't be changed — the new room is already booked at these times: ${clashes.join(" ")}`
    );
  }
  return { movedSessions };
}

// Conflict-checks a room change and resolves the new room's name when the
// class actually has sessions to move. Returns null when there's nothing
// to propagate (no existing sessions) — the caller just does a plain
// class update in that case. Shared by updateClass, updateClassRoom, and
// swapClassRooms so the check/propagation logic can't drift between them.
export async function resolveRoomPropagation(
  classId: string,
  newRoomId: string,
  ignoredClassIds: string[] = []
): Promise<{ movedSessions: number; newRoomName: string } | null> {
  const { movedSessions } = await checkNewRoomForClassSlots(
    classId,
    newRoomId,
    ignoredClassIds
  );
  if (movedSessions === 0) return null;

  const newRoom = await prisma.room.findUniqueOrThrow({
    where: { id: newRoomId },
    select: { name: true },
  });
  return { movedSessions, newRoomName: newRoom.name };
}

// ── Batch "Room Reassignment" planning ───────────────────────────────

export interface ReassignmentRowInput {
  classId: string;
  newRoomId: string;
}

export interface ScopedClassForReassignment {
  id: string;
  name: string;
  roomId: string | null;
  roomName: string | null;
}

export interface ReassignmentChange {
  classId: string;
  className: string;
  oldRoomId: string;
  oldRoomName: string;
  newRoomId: string;
  newRoomName: string;
  movedSessions: number;
}

export interface ReassignmentPlan {
  changes: ReassignmentChange[];
  // Genuine third-party (or final-state double-book) clashes — empty means
  // the whole batch is safe to apply.
  conflicts: string[];
}

// Thrown as readable sentences (whitespace-bearing prose) so the client
// can surface them verbatim via getSchedulingErrorMessage.
const REASSIGN_ERR = {
  NOT_FOUND:
    "One or more selected classes are no longer available for reassignment.",
  CLASS_HAS_NO_ROOM:
    "A selected class has no room assigned yet — use “Change room” for it first.",
  NO_CHANGES: "No room changes were submitted.",
  ROOM_NOT_FOUND: "A selected new room no longer exists.",
} as const;

// Given the caller's ALREADY scope-checked class set and the requested
// {classId,newRoomId} rows, compute the FINAL room for every changing
// class and validate the whole batch as ONE operation:
//   - only end state matters — a chain/cycle of participants handing
//     rooms between themselves never flags itself;
//   - a clash with a class NOT in the batch (a real third-party booking),
//     or two participants ending in the same room at overlapping times,
//     is collected in `conflicts` and blocks the apply.
export async function buildReassignmentPlan(
  scopedClasses: ScopedClassForReassignment[],
  rows: ReassignmentRowInput[]
): Promise<ReassignmentPlan> {
  const byId = new Map(scopedClasses.map((c) => [c.id, c]));

  // Dedupe (last write wins), keep only genuine changes.
  const requested = new Map<string, string>();
  for (const r of rows) requested.set(r.classId, r.newRoomId);

  const changingIds: string[] = [];
  for (const [classId, newRoomId] of requested) {
    const cls = byId.get(classId);
    if (!cls) throw new Error(REASSIGN_ERR.NOT_FOUND);
    if (!cls.roomId) throw new Error(REASSIGN_ERR.CLASS_HAS_NO_ROOM);
    if (newRoomId !== cls.roomId) changingIds.push(classId);
  }
  if (changingIds.length === 0) throw new Error(REASSIGN_ERR.NO_CHANGES);

  const newRoomIds = [...new Set(changingIds.map((id) => requested.get(id)!))];
  const rooms = await prisma.room.findMany({
    where: { id: { in: newRoomIds }, deletedAt: null },
    select: { id: true, name: true },
  });
  const roomNameById = new Map(rooms.map((r) => [r.id, r.name]));
  for (const rid of newRoomIds) {
    if (!roomNameById.has(rid)) throw new Error(REASSIGN_ERR.ROOM_NOT_FOUND);
  }

  // Every participant's FINAL room — the map that makes the check
  // final-state rather than transient (see findRoomClashesForClassSlots).
  const finalRoomByClass = new Map<string, string>();
  for (const id of changingIds) finalRoomByClass.set(id, requested.get(id)!);

  const conflicts = new Set<string>();
  const changes: ReassignmentChange[] = [];

  for (const id of changingIds) {
    const cls = byId.get(id)!;
    const newRoomId = requested.get(id)!;
    const { movedSessions, clashes } = await findRoomClashesForClassSlots(
      id,
      newRoomId,
      [], // no blanket ignore — finalRoomByClass already handles participants
      finalRoomByClass
    );
    for (const c of clashes) conflicts.add(c);
    changes.push({
      classId: id,
      className: cls.name,
      oldRoomId: cls.roomId!,
      oldRoomName: cls.roomName ?? "—",
      newRoomId,
      newRoomName: roomNameById.get(newRoomId)!,
      movedSessions,
    });
  }

  return { changes, conflicts: [...conflicts] };
}
