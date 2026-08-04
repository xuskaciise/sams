import { prisma } from "@/lib/db";
import { ClassesClient } from "./classes-client";

export async function ClassesPanel({ editClassId }: { editClassId?: string } = {}) {
  const [classes, programs, activeAcademicYear, rooms] = await Promise.all([
    prisma.class.findMany({
      include: { program: true, room: { include: { campus: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.program.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    }),
    prisma.academicYear.findFirst({ where: { isActive: true } }),
    // Unscoped, same as every other room picker in the app — Room has no
    // department/faculty affiliation in the schema.
    prisma.room.findMany({
      where: { deletedAt: null },
      include: { campus: true },
      orderBy: [{ campus: { name: "asc" } }, { name: "asc" }],
    }),
  ]);

  // "Intake year" defaults to the active academic year's start year, but
  // stays fully editable for late-registered or backdated cohorts.
  const defaultIntakeYear =
    activeAcademicYear?.startDate.getFullYear() ?? new Date().getFullYear();

  return (
    <ClassesClient
      classes={classes}
      programs={programs}
      rooms={rooms}
      defaultIntakeYear={defaultIntakeYear}
      editClassId={editClassId}
    />
  );
}
