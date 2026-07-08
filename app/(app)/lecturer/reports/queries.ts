import { prisma } from "@/lib/db";

export interface StudentResultRow {
  enrollmentId: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  groupId: string | null;
  groupName: string | null;
  marks: Record<
    string,
    { mark: number | null; attendanceStatus: string; isCorrected: boolean } | null
  >;
  earned: number;
  possible: number;
  percentage: number | null;
}

// The ownership check IS the query: an assignment only ever comes back if
// it belongs to THIS lecturer's session — never trust the assignmentId
// from a URL/action param alone. Same pattern as the student portal's
// enrollment scoping.
export async function getClassResultReport(userId: string, assignmentId: string) {
  const assignment = await prisma.lecturerCourseAssignment.findFirst({
    where: { id: assignmentId, lecturer: { userId } },
    include: {
      course: true,
      class: true,
      semester: { include: { academicYear: true } },
    },
  });
  if (!assignment) return null;

  const enrollments = await prisma.studentCourseEnrollment.findMany({
    where: {
      courseId: assignment.courseId,
      classId: assignment.classId,
      semesterId: assignment.semesterId,
      status: "ACTIVE",
    },
    include: { student: true },
    orderBy: { student: { fullName: "asc" } },
  });

  const assessments = await prisma.assessment.findMany({
    where: { assignmentId, deletedAt: null },
    include: {
      assessmentType: true,
      // PUBLISHED only — a draft mark must never reach this report, and
      // a still-draft assessment simply has no result rows here at all,
      // so every student's cell for it renders the same "—" regardless
      // of whether grading has actually started.
      results: { where: { status: "PUBLISHED" } },
    },
    orderBy: { createdAt: "asc" },
  });

  const groups = await prisma.studentGroup.findMany({
    where: { assignmentId },
    include: { members: true },
    orderBy: { name: "asc" },
  });
  const groupByStudentId = new Map<string, { id: string; name: string }>();
  for (const group of groups) {
    for (const member of group.members) {
      groupByStudentId.set(member.studentId, { id: group.id, name: group.name });
    }
  }

  const resultByEnrollmentAndAssessment = new Map<string, Map<string, (typeof assessments)[number]["results"][number]>>();
  for (const assessment of assessments) {
    for (const result of assessment.results) {
      if (!resultByEnrollmentAndAssessment.has(result.enrollmentId)) {
        resultByEnrollmentAndAssessment.set(result.enrollmentId, new Map());
      }
      resultByEnrollmentAndAssessment.get(result.enrollmentId)!.set(assessment.id, result);
    }
  }

  const students: StudentResultRow[] = enrollments.map((enrollment) => {
    const group = groupByStudentId.get(enrollment.studentId) ?? null;
    const marks: StudentResultRow["marks"] = {};
    let earned = 0;
    let possible = 0;

    for (const assessment of assessments) {
      const result = resultByEnrollmentAndAssessment.get(enrollment.id)?.get(assessment.id);
      if (result) {
        const value = result.mark !== null ? Number(result.mark) : 0;
        earned += value;
        possible += Number(assessment.maximumMarks);
        marks[assessment.id] = {
          mark: result.mark !== null ? Number(result.mark) : null,
          attendanceStatus: result.attendanceStatus,
          isCorrected: result.isCorrected,
        };
      } else {
        marks[assessment.id] = null;
      }
    }

    return {
      enrollmentId: enrollment.id,
      studentId: enrollment.studentId,
      studentNo: enrollment.student.studentNo,
      studentName: enrollment.student.fullName,
      groupId: group?.id ?? null,
      groupName: group?.name ?? null,
      marks,
      earned,
      possible,
      percentage: possible > 0 ? (earned / possible) * 100 : null,
    };
  });

  return {
    assignment,
    assessments: assessments.map((a) => ({
      id: a.id,
      title: a.title,
      typeName: a.assessmentType.name,
      maximumMarks: Number(a.maximumMarks),
      status: a.status,
    })),
    groups: groups.map((g) => ({ id: g.id, name: g.name })),
    students,
  };
}
