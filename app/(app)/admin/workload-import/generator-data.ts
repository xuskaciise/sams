import { prisma } from "@/lib/db";
import { getRoomOptions } from "../timetable/queries";

// Shifts have no department/faculty affiliation in the schema — unscoped,
// same as every other timetable-adjacent picker in this app (the
// Timetable page's own Shift list). Read-only reference data for the
// generator's shift-override control; no permission check of its own
// since it's only ever called from panel.tsx after the caller has already
// been confirmed to hold timetable.generate. Room is deliberately NOT
// fetched here for SCHEDULING purposes — it's a class-registration
// property (Class.roomId) the generator only reads off each assignment's
// class, never picks itself. It IS fetched below (getRoomOptionsForGenerator)
// purely so the multi-class preview's per-session room OVERRIDE control
// (the same "different room for this session" exception the manual Build
// Timetable grid already offers) has something to pick from — reusing the
// existing unscoped room list rather than duplicating the query.
export function getShiftOptionsForGenerator() {
  return prisma.shift.findMany({
    where: { deletedAt: null },
    orderBy: [{ studyMode: "asc" }, { name: "asc" }],
  });
}

export type GeneratorShiftOption = Awaited<ReturnType<typeof getShiftOptionsForGenerator>>[number];

export function getRoomOptionsForGenerator() {
  return getRoomOptions();
}

export type GeneratorRoomOption = Awaited<ReturnType<typeof getRoomOptionsForGenerator>>[number];

// Which Class.currentSemesterNumber levels are eligible for auto-generation
// THIS cycle is a single institution-wide fact driven by whichever real
// academic-calendar Semester is currently active (see
// lib/auto-timetable.ts's parityForAcademicSemesterNumber) — resolved once
// here and threaded down to every entry point that can open the
// generator (all three import tabs' "Continue" flow, plus the persistent
// "Generate timetable" card), never re-derived per assignment. Returns
// null when there's no active Semester, or its semesterNumber hasn't been
// set (a nullable legacy field) — genuinely undeterminable, not a 0/1/2
// guess.
export async function getActiveAcademicSemesterNumber(): Promise<number | null> {
  const active = await prisma.semester.findFirst({
    where: { isActive: true },
    select: { semesterNumber: true },
  });
  return active?.semesterNumber ?? null;
}
