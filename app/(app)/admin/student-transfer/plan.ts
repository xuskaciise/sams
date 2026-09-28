import { prisma } from "@/lib/db";
import { getUserAccess } from "@/lib/auth";
import { getDeanDepartmentIds, classDeanWhere, studentDeanWhere } from "@/lib/dean-scope";
import { formatClassLabel } from "@/lib/class-label";

// Shared, read-only planning for the single-student class transfer — used
// by BOTH the preview action and the real transfer (which re-builds the
// plan from scratch rather than trusting anything the client echoed back,
// same "re-derive before writing" rule as every other confirm action).

export async function resolveTransferScope(userId: string) {
  const { roleNames } = await getUserAccess(userId);
  const isDean = roleNames.includes("DEAN");
  const departmentIds = isDean ? await getDeanDepartmentIds(userId) : [];
  return { isDean, departmentIds };
}

export interface TransferEnrollmentLine {
  enrollmentId: string;
  courseId: string;
  courseName: string;
  // The target class also teaches this course this semester — the old
  // enrollment will be linked (transferredToId) to the new one, and its
  // published marks carry over (read-only) via that chain.
  carriesOver: boolean;
  publishedMarkCount: number;
}

export interface CreateEnrollmentLine {
  courseId: string;
  courseName: string;
  lecturerName: string;
}

export interface GroupLeaveLine {
  groupId: string;
  groupName: string;
  courseName: string;
}

export interface StudentTransferPlan {
  student: { id: string; studentNo: string; fullName: string };
  fromClass: { id: string; label: string };
  toClass: { id: string; label: string };
  activeSemester: { id: string; name: string } | null;
  // False when there's no active semester, or it's already closed — then
  // ONLY Student.classId changes; no enrollment/group is touched (closed-
  // semester data is never modified).
  enrollmentsAffected: boolean;
  toTransfer: TransferEnrollmentLine[];
  toCreate: CreateEnrollmentLine[];
  groupsToLeave: GroupLeaveLine[];
  targetHasNoCourses: boolean;
}

// Throws a readable, user-facing sentence for every blocking condition (the
// client surfaces it verbatim via getSchedulingErrorMessage).
export async function buildStudentTransferPlan(
  userId: string,
  studentId: string,
  targetClassId: string
): Promise<StudentTransferPlan> {
  const { isDean, departmentIds } = await resolveTransferScope(userId);

  // Dean scoping: the query IS the scope check — the student (via their
  // CURRENT class) and the target class must BOTH resolve inside the
  // dean's faculty. Out of scope looks exactly like not found.
  const student = await prisma.student.findFirst({
    where: { id: studentId, ...(isDean ? studentDeanWhere(departmentIds) : {}) },
    include: { class: true },
  });
  if (!student) {
    throw new Error("Student not found (or outside your faculty).");
  }
  if (!student.isActive) {
    throw new Error(
      `${student.fullName} is inactive — reactivate the student before transferring them to another class.`
    );
  }
  if (student.classId === targetClassId) {
    throw new Error("The student is already in that class — pick a different target class.");
  }

  const targetClass = await prisma.class.findFirst({
    where: {
      id: targetClassId,
      deletedAt: null,
      ...(isDean ? classDeanWhere(departmentIds) : {}),
    },
  });
  if (!targetClass) {
    throw new Error("Target class not found (or outside your faculty, or deactivated).");
  }

  const semester = await prisma.semester.findFirst({ where: { isActive: true } });
  const enrollmentsAffected = !!semester && !semester.isClosed;

  const base: StudentTransferPlan = {
    student: { id: student.id, studentNo: student.studentNo, fullName: student.fullName },
    fromClass: { id: student.class.id, label: formatClassLabel(student.class) },
    toClass: { id: targetClass.id, label: formatClassLabel(targetClass) },
    activeSemester: semester ? { id: semester.id, name: semester.name } : null,
    enrollmentsAffected,
    toTransfer: [],
    toCreate: [],
    groupsToLeave: [],
    targetHasNoCourses: true,
  };
  if (!enrollmentsAffected || !semester) return base;

  const [activeEnrollments, targetAssignments, oldAssignments] = await Promise.all([
    prisma.studentCourseEnrollment.findMany({
      where: { studentId: student.id, semesterId: semester.id, status: "ACTIVE" },
      include: { course: true },
      orderBy: { course: { name: "asc" } },
    }),
    prisma.lecturerCourseAssignment.findMany({
      where: { classId: targetClass.id, semesterId: semester.id },
      include: { course: true, lecturer: { select: { fullName: true } } },
      orderBy: { course: { name: "asc" } },
    }),
    prisma.lecturerCourseAssignment.findMany({
      where: { classId: student.classId, semesterId: semester.id },
      include: { course: true },
    }),
  ]);

  // The (student, course, semester, status) unique index is a FULL index,
  // not a partial one — so a course that already has a TRANSFERRED row
  // this semester (e.g. the student was transferred once already) can't
  // get a second one. Surface that precisely instead of letting the
  // transaction hit a raw P2002.
  const alreadyTransferred = activeEnrollments.length
    ? await prisma.studentCourseEnrollment.findMany({
        where: {
          studentId: student.id,
          semesterId: semester.id,
          status: "TRANSFERRED",
          courseId: { in: activeEnrollments.map((e) => e.courseId) },
        },
        include: { course: true },
      })
    : [];
  if (alreadyTransferred.length > 0) {
    const names = alreadyTransferred.map((e) => e.course.name).join(", ");
    throw new Error(
      `${student.fullName} was already transferred out of ${names} earlier this semester — a second transfer for the same course in one semester isn't supported. Adjust those enrollments manually from Enrollments.`
    );
  }

  const publishedCounts = activeEnrollments.length
    ? await prisma.assessmentResult.findMany({
        where: {
          enrollmentId: { in: activeEnrollments.map((e) => e.id) },
          status: "PUBLISHED",
        },
        select: { enrollmentId: true },
      })
    : [];
  const countByEnrollment = new Map<string, number>();
  for (const r of publishedCounts) {
    countByEnrollment.set(r.enrollmentId, (countByEnrollment.get(r.enrollmentId) ?? 0) + 1);
  }

  const targetCourseIds = new Set(targetAssignments.map((a) => a.courseId));

  const seenCourse = new Set<string>();
  const toCreate: CreateEnrollmentLine[] = [];
  for (const a of targetAssignments) {
    if (seenCourse.has(a.courseId)) continue;
    seenCourse.add(a.courseId);
    toCreate.push({ courseId: a.courseId, courseName: a.course.name, lecturerName: a.lecturer.fullName });
  }

  const oldAssignmentById = new Map(oldAssignments.map((a) => [a.id, a]));
  const memberships = oldAssignments.length
    ? await prisma.groupMember.findMany({
        where: { studentId: student.id, assignmentId: { in: oldAssignments.map((a) => a.id) } },
        include: { group: true },
      })
    : [];

  return {
    ...base,
    toTransfer: activeEnrollments.map((e) => ({
      enrollmentId: e.id,
      courseId: e.courseId,
      courseName: e.course.name,
      carriesOver: targetCourseIds.has(e.courseId),
      publishedMarkCount: countByEnrollment.get(e.id) ?? 0,
    })),
    toCreate,
    groupsToLeave: memberships.map((m) => ({
      groupId: m.groupId,
      groupName: m.group.name,
      courseName: oldAssignmentById.get(m.assignmentId)?.course.name ?? "—",
    })),
    targetHasNoCourses: toCreate.length === 0,
  };
}
