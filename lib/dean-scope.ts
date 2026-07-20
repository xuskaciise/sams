import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

// A dean's visible/actionable universe = classes whose program belongs to
// one of their overseen departments, plus everything under those classes.
// Permissions (lib/permissions.ts) define WHAT a dean can do; dean_departments
// (this helper) defines WHERE. Every dean-facing query/action must apply
// one of the where-builders below — never trust an id from a URL/action
// param without nesting it through here first (same "ownership check IS
// the query" principle as requireAssignmentOwner in lib/auth.ts).
export async function getDeanDepartmentIds(userId: string): Promise<string[]> {
  const rows = await prisma.deanDepartment.findMany({
    where: { userId },
    select: { departmentId: true },
  });
  return rows.map((r) => r.departmentId);
}

// The one shared predicate every helper below nests under a `program`
// relation. An empty departmentIds array (unassigned dean) is intentional,
// not a bug: Prisma's `{ in: [] }` matches nothing, so every helper below
// naturally returns zero rows — the same code path as a scoped dean, no
// special-casing needed for "an unassigned dean sees nothing".
export function deanScopeWhere(
  departmentIds: string[]
): Prisma.ProgramWhereInput {
  return { departmentId: { in: departmentIds } };
}

export function classDeanWhere(
  departmentIds: string[]
): Prisma.ClassWhereInput {
  return { program: deanScopeWhere(departmentIds) };
}

export function assignmentDeanWhere(
  departmentIds: string[]
): Prisma.LecturerCourseAssignmentWhereInput {
  return { class: classDeanWhere(departmentIds) };
}

export function enrollmentDeanWhere(
  departmentIds: string[]
): Prisma.StudentCourseEnrollmentWhereInput {
  return { class: classDeanWhere(departmentIds) };
}

export function assessmentDeanWhere(
  departmentIds: string[]
): Prisma.AssessmentWhereInput {
  return { assignment: assignmentDeanWhere(departmentIds) };
}

export function resultDeanWhere(
  departmentIds: string[]
): Prisma.AssessmentResultWhereInput {
  return { enrollment: enrollmentDeanWhere(departmentIds) };
}

export function studentDeanWhere(
  departmentIds: string[]
): Prisma.StudentWhereInput {
  return { class: classDeanWhere(departmentIds) };
}

// "The lecturers teaching them" — a dean's visible lecturer pool is exactly
// the lecturers currently holding at least one assignment within their
// scoped departments, not every lecturer university-wide. This is also the
// candidate pool for ownership transfer's "new lecturer" picker.
export function lecturerDeanWhere(
  departmentIds: string[]
): Prisma.LecturerWhereInput {
  return { assignments: { some: assignmentDeanWhere(departmentIds) } };
}
