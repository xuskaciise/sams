import { prisma } from "@/lib/db";

// Shifts have no department/faculty affiliation in the schema — unscoped,
// same as every other timetable-adjacent picker in this app (the
// Timetable page's own Shift list). Read-only reference data for the
// generator's shift-override control; no permission check of its own
// since it's only ever called from panel.tsx after the caller has already
// been confirmed to hold timetable.generate. Room is deliberately NOT
// fetched here — it's a class-registration property (Class.roomId) the
// generator only reads off each assignment's class, never picks itself.
export function getShiftOptionsForGenerator() {
  return prisma.shift.findMany({
    where: { deletedAt: null },
    orderBy: [{ studyMode: "asc" }, { name: "asc" }],
  });
}

export type GeneratorShiftOption = Awaited<ReturnType<typeof getShiftOptionsForGenerator>>[number];
