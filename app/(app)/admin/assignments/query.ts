import type { Prisma } from "@prisma/client";

export const ALL_SEMESTERS_VALUE = "all";

export interface AssignmentFilters {
  classId?: string;
  courseId?: string;
  lecturerId?: string;
  semesterId?: string;
  q?: string;
}

// Absent semesterId -> default to the active semester. Explicit "all"
// -> no semester filter at all. Anything else -> that exact semester.
export function resolveEffectiveSemesterId(
  semesterId: string | undefined,
  activeSemesterId: string | undefined
): string | undefined {
  return semesterId === ALL_SEMESTERS_VALUE
    ? undefined
    : (semesterId ?? activeSemesterId);
}

// Shared by the on-screen table (panel.tsx) and the Excel export
// (actions.ts) so the two can never disagree about which rows match.
export function buildAssignmentsWhere(
  filters: AssignmentFilters,
  effectiveSemesterId: string | undefined
): Prisma.LecturerCourseAssignmentWhereInput {
  return {
    ...(filters.classId ? { classId: filters.classId } : {}),
    ...(filters.courseId ? { courseId: filters.courseId } : {}),
    ...(filters.lecturerId ? { lecturerId: filters.lecturerId } : {}),
    ...(effectiveSemesterId ? { semesterId: effectiveSemesterId } : {}),
    ...(filters.q
      ? {
          OR: [
            { course: { name: { contains: filters.q, mode: "insensitive" } } },
            { class: { name: { contains: filters.q, mode: "insensitive" } } },
            {
              lecturer: {
                fullName: { contains: filters.q, mode: "insensitive" },
              },
            },
          ],
        }
      : {}),
  };
}
