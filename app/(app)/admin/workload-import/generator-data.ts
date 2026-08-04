import { prisma } from "@/lib/db";

// Rooms/shifts have no department/faculty affiliation in the schema —
// unscoped, same as every other timetable-adjacent picker in this app
// (the Timetable page's own Room/Shift lists). Read-only reference data
// for the generator's setup step; no permission check of its own since
// it's only ever called from panel.tsx after the caller has already been
// confirmed to hold timetable.generate.
export function getRoomOptionsForGenerator() {
  return prisma.room.findMany({
    where: { deletedAt: null },
    include: { campus: true },
    orderBy: [{ campus: { name: "asc" } }, { name: "asc" }],
  });
}

export function getShiftOptionsForGenerator() {
  return prisma.shift.findMany({
    where: { deletedAt: null },
    orderBy: [{ studyMode: "asc" }, { name: "asc" }],
  });
}

export type GeneratorRoomOption = Awaited<ReturnType<typeof getRoomOptionsForGenerator>>[number];
export type GeneratorShiftOption = Awaited<ReturnType<typeof getShiftOptionsForGenerator>>[number];
