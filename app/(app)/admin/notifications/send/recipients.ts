import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getUserAccess } from "@/lib/auth";
import {
  getDeanDepartmentIds,
  classDeanWhere,
  studentDeanWhere,
  lecturerDeanWhere,
} from "@/lib/dean-scope";

// Send Notification's own WHERE tier — deliberately re-derived from the
// caller's actual ROLE every call, same idiom as Daily Log/Timetable/
// Workload Import (see CLAUDE.md): permissions (notification.send.manual)
// answer WHAT a sender can do, this answers WHERE. A DEAN+LECTURER (or
// DEAN+ADMIN) multi-role user is always treated as DEAN here, matching
// the same precedence those other features already established.
export type SenderTier = "ADMIN" | "DEAN" | "LECTURER";

export interface SenderScope {
  tier: SenderTier;
  departmentIds: string[]; // only meaningful for DEAN
  lecturerId: string | null; // only meaningful for LECTURER — their own Lecturer.id
}

export async function resolveSenderScope(userId: string): Promise<SenderScope> {
  const { roleNames } = await getUserAccess(userId);

  if (roleNames.includes("DEAN")) {
    return { tier: "DEAN", departmentIds: await getDeanDepartmentIds(userId), lecturerId: null };
  }
  if (roleNames.includes("ADMIN")) {
    return { tier: "ADMIN", departmentIds: [], lecturerId: null };
  }

  // Anyone else holding notification.send.manual (LECTURER, or a custom
  // role with none of DEAN/ADMIN) is scoped as a lecturer — own course
  // assignments only. A user with no Lecturer profile at all simply has
  // no assignments, so every lookup below naturally resolves to nothing.
  const lecturer = await prisma.lecturer.findUnique({ where: { userId } });
  return { tier: "LECTURER", departmentIds: [], lecturerId: lecturer?.id ?? null };
}

// (courseId, classId, semesterId) tuples for every course this lecturer
// currently teaches — there is no direct relation from
// StudentCourseEnrollment to LecturerCourseAssignment (see CLAUDE.md's
// "no direct relation from enrollment to assignment" note on
// getMyTimetableForStudent); enrollments are matched by this tuple
// instead, same pattern used there and in lecturer/reports/queries.ts.
export async function getLecturerAssignmentTuples(lecturerId: string) {
  const assignments = await prisma.lecturerCourseAssignment.findMany({
    where: { lecturerId },
    select: { courseId: true, classId: true, semesterId: true },
  });
  return assignments.map((a) => ({
    courseId: a.courseId,
    classId: a.classId,
    semesterId: a.semesterId,
  }));
}

export interface ResolvedRecipient {
  type: "STUDENT" | "LECTURER";
  id: string;
  name: string;
  phoneNumber: string | null;
  className?: string; // STUDENT only
}

export interface ResolveRecipientsParams {
  scope: SenderScope;
  recipientKind: "STUDENT" | "LECTURER";
  target: "INDIVIDUAL" | "CLASS" | "FACULTY";
  targetId: string;
}

export interface ResolvedRecipients {
  recipients: ResolvedRecipient[];
  facultyName: string; // "" unless target === "FACULTY"
}

// The one place recipients are actually resolved for a manual send —
// used by BOTH the live preview action and the real send action, so a
// sender can never see a preview that the send itself would resolve
// differently. Every branch re-derives its own boundary from `scope`
// (never trusts targetId alone) — same "ownership-check-IS-the-query"
// idiom as requireAssignmentOwner/the rest of this app's dean-scoped
// features. Verified directly against a real Prisma 6.19 query
// (`OR: []` / `{ in: [] }` both match zero rows, never "no filter") — an
// empty tuple/department list below is always a safe, explicit
// zero-result guard, not a silent widen.
export async function resolveManualRecipients(
  params: ResolveRecipientsParams
): Promise<ResolvedRecipients> {
  const { scope, recipientKind, target, targetId } = params;

  if (recipientKind === "LECTURER") {
    // A lecturer can only ever notify their OWN students — never another
    // lecturer, per the explicit business rule this feature was built
    // against.
    if (scope.tier === "LECTURER") throw new Error("FORBIDDEN");

    if (target === "INDIVIDUAL") {
      const lecturer = await prisma.lecturer.findFirst({
        where: {
          id: targetId,
          ...(scope.tier === "DEAN" ? lecturerDeanWhere(scope.departmentIds) : {}),
        },
        select: { id: true, fullName: true, phoneNumber: true },
      });
      if (!lecturer) throw new Error("NOT_FOUND");
      return {
        recipients: [
          { type: "LECTURER", id: lecturer.id, name: lecturer.fullName, phoneNumber: lecturer.phoneNumber },
        ],
        facultyName: "",
      };
    }

    if (target === "FACULTY") {
      if (scope.tier === "DEAN" && !scope.departmentIds.includes(targetId)) {
        throw new Error("FORBIDDEN");
      }
      const department = await prisma.department.findUnique({
        where: { id: targetId },
        select: { name: true },
      });
      if (!department) throw new Error("NOT_FOUND");
      // Lecturer.departmentId is the lecturer's registered home faculty
      // (a plain profile field — see CLAUDE.md's "Lecturer registration
      // split") — the natural meaning of "every lecturer IN this
      // faculty", distinct from lecturerDeanWhere's "currently teaching
      // in-scope" (used for the INDIVIDUAL picker above, matching Dean
      // Ownership Transfer's existing precedent).
      const lecturers = await prisma.lecturer.findMany({
        where: { departmentId: targetId },
        select: { id: true, fullName: true, phoneNumber: true },
      });
      return {
        recipients: lecturers.map((l) => ({
          type: "LECTURER" as const,
          id: l.id,
          name: l.fullName,
          phoneNumber: l.phoneNumber,
        })),
        facultyName: department.name,
      };
    }

    throw new Error("INVALID_SCOPE");
  }

  // recipientKind === "STUDENT"
  if (target === "INDIVIDUAL") {
    let where: Prisma.StudentWhereInput = { id: targetId };
    if (scope.tier === "DEAN") {
      where = { ...where, ...studentDeanWhere(scope.departmentIds) };
    } else if (scope.tier === "LECTURER") {
      if (!scope.lecturerId) throw new Error("NOT_FOUND");
      const tuples = await getLecturerAssignmentTuples(scope.lecturerId);
      if (tuples.length === 0) throw new Error("NOT_FOUND");
      where = { ...where, enrollments: { some: { status: "ACTIVE", OR: tuples } } };
    }
    const student = await prisma.student.findFirst({
      where,
      select: { id: true, fullName: true, phoneNumber: true, class: { select: { name: true } } },
    });
    if (!student) throw new Error("NOT_FOUND");
    return {
      recipients: [
        {
          type: "STUDENT",
          id: student.id,
          name: student.fullName,
          phoneNumber: student.phoneNumber,
          className: student.class.name,
        },
      ],
      facultyName: "",
    };
  }

  if (target === "CLASS") {
    if (scope.tier === "LECTURER") {
      if (!scope.lecturerId) throw new Error("NOT_FOUND");
      const assignment = await prisma.lecturerCourseAssignment.findFirst({
        where: { id: targetId, lecturerId: scope.lecturerId },
        select: { courseId: true, classId: true, semesterId: true },
      });
      if (!assignment) throw new Error("NOT_FOUND");
      const enrollments = await prisma.studentCourseEnrollment.findMany({
        where: {
          status: "ACTIVE",
          courseId: assignment.courseId,
          classId: assignment.classId,
          semesterId: assignment.semesterId,
        },
        select: {
          student: {
            select: { id: true, fullName: true, phoneNumber: true, class: { select: { name: true } } },
          },
        },
      });
      return {
        recipients: enrollments.map((e) => ({
          type: "STUDENT" as const,
          id: e.student.id,
          name: e.student.fullName,
          phoneNumber: e.student.phoneNumber,
          className: e.student.class.name,
        })),
        facultyName: "",
      };
    }

    const classRow = await prisma.class.findFirst({
      where: {
        id: targetId,
        ...(scope.tier === "DEAN" ? classDeanWhere(scope.departmentIds) : {}),
      },
      select: { id: true, name: true },
    });
    if (!classRow) throw new Error("NOT_FOUND");
    const students = await prisma.student.findMany({
      where: { classId: classRow.id },
      select: { id: true, fullName: true, phoneNumber: true },
    });
    return {
      recipients: students.map((s) => ({
        type: "STUDENT" as const,
        id: s.id,
        name: s.fullName,
        phoneNumber: s.phoneNumber,
        className: classRow.name,
      })),
      facultyName: "",
    };
  }

  if (target === "FACULTY") {
    if (scope.tier === "LECTURER") throw new Error("FORBIDDEN");
    if (scope.tier === "DEAN" && !scope.departmentIds.includes(targetId)) {
      throw new Error("FORBIDDEN");
    }
    const department = await prisma.department.findUnique({
      where: { id: targetId },
      select: { name: true },
    });
    if (!department) throw new Error("NOT_FOUND");
    // studentDeanWhere([targetId]) reused for exactly ONE department —
    // it's a plain (department -> program -> class) predicate, nothing
    // dean-specific about its shape, so this is the same helper every
    // other "students in faculty X" lookup in this app already relies on.
    const students = await prisma.student.findMany({
      where: studentDeanWhere([targetId]),
      select: { id: true, fullName: true, phoneNumber: true, class: { select: { name: true } } },
    });
    return {
      recipients: students.map((s) => ({
        type: "STUDENT" as const,
        id: s.id,
        name: s.fullName,
        phoneNumber: s.phoneNumber,
        className: s.class.name,
      })),
      facultyName: department.name,
    };
  }

  throw new Error("INVALID_SCOPE");
}
