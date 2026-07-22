import { prisma } from "@/lib/db";
import { ClassesClient } from "./classes-client";

export async function ClassesPanel() {
  const [classes, programs, activeAcademicYear] = await Promise.all([
    prisma.class.findMany({
      include: { program: true },
      orderBy: { name: "asc" },
    }),
    prisma.program.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    }),
    prisma.academicYear.findFirst({ where: { isActive: true } }),
  ]);

  // "Intake year" defaults to the active academic year's start year, but
  // stays fully editable for late-registered or backdated cohorts.
  const defaultIntakeYear =
    activeAcademicYear?.startDate.getFullYear() ?? new Date().getFullYear();

  return (
    <ClassesClient
      classes={classes}
      programs={programs}
      defaultIntakeYear={defaultIntakeYear}
    />
  );
}
