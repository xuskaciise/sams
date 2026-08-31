import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolvePageParams } from "@/lib/pagination";
import { StudentsClient } from "./students-client";

export interface StudentsSearchParams {
  classId?: string;
  semester?: string;
  status?: string;
  q?: string;
  page?: string;
  pageSize?: string;
}

export async function StudentsPanel({
  searchParams,
}: {
  searchParams: StudentsSearchParams;
}) {
  const { page, pageSize, skip, take } = resolvePageParams(searchParams);

  // Filter by the student's class's current cycle level (1..8) — the same
  // "(Semester N)" shown in the class label. Ignore anything not a valid
  // level rather than 500 on a hand-edited URL param.
  const semesterNumber = Number(searchParams.semester);
  const semesterFilter =
    Number.isInteger(semesterNumber) && semesterNumber >= 1 && semesterNumber <= 8
      ? semesterNumber
      : null;

  const where: Prisma.StudentWhereInput = {
    ...(searchParams.classId ? { classId: searchParams.classId } : {}),
    ...(semesterFilter
      ? { class: { currentSemesterNumber: semesterFilter } }
      : {}),
    ...(searchParams.status === "active"
      ? { isActive: true }
      : searchParams.status === "inactive"
        ? { isActive: false }
        : {}),
    ...(searchParams.q
      ? {
          OR: [
            { fullName: { contains: searchParams.q, mode: "insensitive" } },
            { studentNo: { contains: searchParams.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [students, total, classes] = await Promise.all([
    prisma.student.findMany({
      where,
      include: { class: true, user: true },
      orderBy: { fullName: "asc" },
      skip,
      take,
    }),
    prisma.student.count({ where }),
    prisma.class.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <StudentsClient
      students={students}
      classes={classes}
      total={total}
      page={page}
      pageSize={pageSize}
    />
  );
}
