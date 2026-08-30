import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolvePageParams } from "@/lib/pagination";
import { ClassesClient } from "./classes-client";

export interface ClassesSearchParams {
  programId?: string;
  mode?: string;
  period?: string;
  semesterNumber?: string;
  status?: string;
  q?: string;
  page?: string;
  pageSize?: string;
  // Deep-link from the Timetable Builder's "this class has no room" block.
  editClassId?: string;
}

export async function ClassesPanel({
  searchParams = {},
}: {
  searchParams?: ClassesSearchParams;
} = {}) {
  const { editClassId } = searchParams;
  const { page, pageSize, skip, take } = resolvePageParams(searchParams);

  const semesterNumber = Number(searchParams.semesterNumber);

  const where: Prisma.ClassWhereInput = {
    ...(searchParams.programId ? { programId: searchParams.programId } : {}),
    ...(searchParams.mode === "FT" || searchParams.mode === "PT"
      ? { studyMode: searchParams.mode }
      : {}),
    ...(searchParams.period === "MORNING" || searchParams.period === "AFTERNOON"
      ? { period: searchParams.period }
      : {}),
    ...(Number.isInteger(semesterNumber) &&
    semesterNumber >= 1 &&
    semesterNumber <= 8
      ? { currentSemesterNumber: semesterNumber }
      : {}),
    ...(searchParams.status === "active"
      ? { deletedAt: null }
      : searchParams.status === "inactive"
        ? { deletedAt: { not: null } }
        : {}),
    ...(searchParams.q
      ? {
          OR: [
            { name: { contains: searchParams.q, mode: "insensitive" } },
            { batchCode: { contains: searchParams.q, mode: "insensitive" } },
            { section: { contains: searchParams.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [
    classes,
    total,
    allClasses,
    programs,
    activeAcademicYear,
    rooms,
    editClass,
  ] = await Promise.all([
    prisma.class.findMany({
      where,
      include: { program: true, room: { include: { campus: true } } },
      orderBy: { name: "asc" },
      skip,
      take,
    }),
    prisma.class.count({ where }),
    // Full, lightweight list for the "Bulk update period" dialog, which
    // runs its own client-side FT/active filtering over EVERY class — it
    // can't work off just the current (filtered/paginated) page.
    prisma.class.findMany({
      include: { program: true },
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
    // The deep-link target may be filtered out or on another page, so
    // resolve it directly rather than off the current page's rows.
    editClassId
      ? prisma.class.findUnique({
          where: { id: editClassId },
          include: { program: true, room: { include: { campus: true } } },
        })
      : Promise.resolve(null),
  ]);

  // "Intake year" defaults to the active academic year's start year, but
  // stays fully editable for late-registered or backdated cohorts.
  const defaultIntakeYear =
    activeAcademicYear?.startDate.getFullYear() ?? new Date().getFullYear();

  return (
    <ClassesClient
      classes={classes}
      allClasses={allClasses}
      programs={programs}
      rooms={rooms}
      defaultIntakeYear={defaultIntakeYear}
      editClass={editClass}
      total={total}
      page={page}
      pageSize={pageSize}
    />
  );
}
