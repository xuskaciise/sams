import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolvePageParams } from "@/lib/pagination";
import { AssignmentsClient } from "./assignments-client";

export interface AssignmentsSearchParams {
  classId?: string;
  courseId?: string;
  lecturerId?: string;
  semesterId?: string;
  q?: string;
  page?: string;
  pageSize?: string;
}

export const ALL_SEMESTERS_VALUE = "all";

export async function AssignmentsPanel({
  searchParams,
}: {
  searchParams: AssignmentsSearchParams;
}) {
  const { page, pageSize, skip, take } = resolvePageParams(searchParams);

  const [lecturers, courses, classesWithPlans, semesters] = await Promise.all([
    prisma.lecturer.findMany({
      include: { user: true },
      where: { user: { deletedAt: null } },
      orderBy: { user: { fullName: "asc" } },
    }),
    // Kept flat for name lookups only (e.g. the bulk-assign result
    // summary) — course PICKERS are built from each class's
    // ClassCoursePlan instead, not this list.
    prisma.course.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    }),
    prisma.class.findMany({
      where: { deletedAt: null },
      include: {
        coursePlans: {
          include: { course: true },
          orderBy: [{ semesterNumber: "asc" }, { course: { name: "asc" } }],
        },
      },
      orderBy: { name: "asc" },
    }),
    // ALL semesters (not just open ones) — the filter dropdown needs to
    // browse historical/closed-semester assignments too, even though the
    // Add/Bulk dialogs only ever offer non-closed ones for NEW rows.
    prisma.semester.findMany({
      include: { academicYear: true },
      orderBy: { startDate: "desc" },
    }),
  ]);

  const activeSemester = semesters.find((s) => s.isActive) ?? null;
  // Absent semesterId -> default to the active semester. Explicit "all"
  // -> no semester filter at all. Anything else -> that exact semester.
  const effectiveSemesterId =
    searchParams.semesterId === ALL_SEMESTERS_VALUE
      ? undefined
      : (searchParams.semesterId ?? activeSemester?.id);

  const where: Prisma.LecturerCourseAssignmentWhereInput = {
    ...(searchParams.classId ? { classId: searchParams.classId } : {}),
    ...(searchParams.courseId ? { courseId: searchParams.courseId } : {}),
    ...(searchParams.lecturerId ? { lecturerId: searchParams.lecturerId } : {}),
    ...(effectiveSemesterId ? { semesterId: effectiveSemesterId } : {}),
    ...(searchParams.q
      ? {
          OR: [
            { course: { name: { contains: searchParams.q, mode: "insensitive" } } },
            { class: { name: { contains: searchParams.q, mode: "insensitive" } } },
            {
              lecturer: {
                user: { fullName: { contains: searchParams.q, mode: "insensitive" } },
              },
            },
          ],
        }
      : {}),
  };

  const [assignments, total] = await Promise.all([
    prisma.lecturerCourseAssignment.findMany({
      where,
      include: {
        lecturer: { include: { user: true } },
        course: true,
        class: true,
        semester: true,
      },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    prisma.lecturerCourseAssignment.count({ where }),
  ]);

  return (
    <AssignmentsClient
      assignments={assignments}
      total={total}
      page={page}
      pageSize={pageSize}
      lecturers={lecturers}
      courses={courses}
      classesWithPlans={classesWithPlans}
      semesters={semesters}
      activeSemesterId={activeSemester?.id ?? ""}
    />
  );
}
