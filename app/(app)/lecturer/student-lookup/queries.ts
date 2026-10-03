import { prisma } from "@/lib/db";
import { formatClassLabel } from "@/lib/class-label";
import {
  resolveLookupRowAction,
  type AssessmentStatus,
  type EnrollmentStatus,
  type LookupRowAction,
  type ResultStatus,
} from "./row-action";

export interface StudentLookupRow {
  assessmentId: string;
  courseName: string;
  classLabel: string;
  semesterLabel: string;
  title: string;
  typeName: string;
  maximumMarks: number;
  assessmentStatus: AssessmentStatus;
  enrollmentId: string;
  enrollmentStatus: EnrollmentStatus;
  resultId: string | null;
  resultStatus: ResultStatus | null;
  mark: number | null;
  attendanceStatus: "PRESENT" | "ABSENT" | "EXEMPT";
  updatedAt: string | null;
  isCorrected: boolean;
  // Reference-only group link (snapshot model), passed back into saveResult /
  // addLateResult unchanged so editing from here never silently clears the
  // groupId a GROUP-mode result already carries.
  groupId: string | null;
  action: LookupRowAction;
}

export interface StudentLookupResult {
  student: { id: string; studentNo: string; fullName: string };
  rows: StudentLookupRow[];
}

// Ownership-scoped: only assignments whose CURRENT lecturer is this user
// (`lecturer: { userId }`, the same predicate My Courses / Reports / the
// assessment page use — an ownership transfer flips it). A student who
// isn't enrolled in any of them — or doesn't exist at all — returns null;
// the two cases are deliberately indistinguishable so the lookup can't be
// used to probe for students outside the lecturer's own courses.
export async function getStudentResultsForLecturer(
  userId: string,
  studentNo: string
): Promise<StudentLookupResult | null> {
  const normalized = studentNo.trim();
  if (!normalized) return null;

  const assignments = await prisma.lecturerCourseAssignment.findMany({
    where: { lecturer: { userId } },
    include: {
      course: true,
      class: true,
      semester: { include: { academicYear: true } },
      assessments: {
        where: { deletedAt: null },
        include: { assessmentType: true },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: [{ semester: { startDate: "desc" } }, { course: { name: "asc" } }],
  });
  if (assignments.length === 0) return null;

  const student = await prisma.student.findFirst({
    where: { studentNo: { equals: normalized, mode: "insensitive" } },
    select: { id: true, studentNo: true, fullName: true },
  });
  if (!student) return null;

  const enrollments = await prisma.studentCourseEnrollment.findMany({
    where: {
      studentId: student.id,
      status: { not: "DROPPED" },
      OR: assignments.map((a) => ({
        courseId: a.courseId,
        classId: a.classId,
        semesterId: a.semesterId,
      })),
    },
  });
  if (enrollments.length === 0) return null;

  const tupleKey = (c: string, k: string, s: string) => `${c}:${k}:${s}`;
  // Prefer the ACTIVE enrollment for a tuple — that's the row the Marks
  // Entry Grid itself shows.
  const enrollmentByTuple = new Map<string, (typeof enrollments)[number]>();
  for (const e of enrollments) {
    const key = tupleKey(e.courseId, e.classId, e.semesterId);
    const current = enrollmentByTuple.get(key);
    if (!current || (current.status !== "ACTIVE" && e.status === "ACTIVE")) {
      enrollmentByTuple.set(key, e);
    }
  }

  const matched = assignments.filter((a) =>
    enrollmentByTuple.has(tupleKey(a.courseId, a.classId, a.semesterId))
  );
  const assessmentIds = matched.flatMap((a) => a.assessments.map((x) => x.id));
  const enrollmentIds = [...enrollmentByTuple.values()].map((e) => e.id);

  const [results, memberships] = await Promise.all([
    assessmentIds.length
      ? prisma.assessmentResult.findMany({
          where: {
            assessmentId: { in: assessmentIds },
            enrollmentId: { in: enrollmentIds },
          },
        })
      : Promise.resolve([]),
    prisma.groupMember.findMany({
      where: { studentId: student.id, assignmentId: { in: matched.map((a) => a.id) } },
      select: { assignmentId: true, groupId: true },
    }),
  ]);

  const resultByKey = new Map(
    results.map((r) => [`${r.assessmentId}:${r.enrollmentId}`, r])
  );
  const groupByAssignment = new Map(memberships.map((m) => [m.assignmentId, m.groupId]));

  const rows: StudentLookupRow[] = [];
  for (const a of matched) {
    const enrollment = enrollmentByTuple.get(tupleKey(a.courseId, a.classId, a.semesterId))!;
    const enrollmentStatus = enrollment.status as EnrollmentStatus;
    for (const assessment of a.assessments) {
      const result = resultByKey.get(`${assessment.id}:${enrollment.id}`);
      const assessmentStatus = assessment.status as AssessmentStatus;
      const resultStatus = (result?.status ?? null) as ResultStatus | null;
      rows.push({
        assessmentId: assessment.id,
        courseName: a.course.name,
        classLabel: formatClassLabel(a.class),
        semesterLabel: `${a.semester.name} (${a.semester.academicYear.name})`,
        title: assessment.title,
        typeName: assessment.assessmentType.name,
        maximumMarks: Number(assessment.maximumMarks),
        assessmentStatus,
        enrollmentId: enrollment.id,
        enrollmentStatus,
        resultId: result?.id ?? null,
        resultStatus,
        mark: result?.mark != null ? Number(result.mark) : null,
        attendanceStatus: result?.attendanceStatus ?? "PRESENT",
        updatedAt: result?.updatedAt.toISOString() ?? null,
        isCorrected: result?.isCorrected ?? false,
        groupId:
          result?.groupId ??
          (assessment.mode === "GROUP" ? (groupByAssignment.get(a.id) ?? null) : null),
        action: resolveLookupRowAction({ assessmentStatus, resultStatus, enrollmentStatus }),
      });
    }
  }

  return { student, rows };
}
