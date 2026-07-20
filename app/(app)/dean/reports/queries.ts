import { prisma } from "@/lib/db";
import type { AssessmentStatus } from "@prisma/client";
import {
  assignmentDeanWhere,
  classDeanWhere,
  enrollmentDeanWhere,
  studentDeanWhere,
} from "@/lib/dean-scope";

// All three reports are PUBLISHED-only, same as the student portal —
// Dean reports mirror what students can actually see, they don't grant a
// backdoor into draft marks. A still-draft assessment still appears in
// the per-course breakdown (so the Dean can see grading isn't done) but
// contributes nothing to any average/top/lowest figure.

export interface StudentTotal {
  enrollmentId: string;
  studentNo: string;
  studentName: string;
  earned: number;
  possible: number;
  percentage: number | null;
}

export interface AssessmentBreakdownRow {
  assessmentId: string;
  title: string;
  typeName: string;
  maximumMarks: number;
  status: AssessmentStatus;
  gradedCount: number;
  average: number | null;
  top: { studentName: string; mark: number } | null;
  lowest: { studentName: string; mark: number } | null;
}

export async function getCourseReport(
  assignmentId: string,
  departmentIds: string[]
) {
  // The scope check IS the query: an assignment outside this dean's
  // overseen departments simply doesn't come back.
  const assignment = await prisma.lecturerCourseAssignment.findFirst({
    where: { id: assignmentId, ...assignmentDeanWhere(departmentIds) },
    include: {
      // select, not include: this crosses into a client-facing report —
      // no need to ship the lecturer's full User row (password hash etc.)
      // just to display their name.
      lecturer: { select: { user: { select: { fullName: true } } } },
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
  const studentNameByEnrollment = new Map(
    enrollments.map((e) => [e.id, e.student.fullName])
  );

  const assessments = await prisma.assessment.findMany({
    where: { assignmentId, deletedAt: null },
    include: {
      assessmentType: true,
      results: { where: { status: "PUBLISHED" } },
    },
    orderBy: { createdAt: "asc" },
  });

  const totalsByEnrollment = new Map<string, { earned: number; possible: number }>(
    enrollments.map((e) => [e.id, { earned: 0, possible: 0 }])
  );

  const breakdown: AssessmentBreakdownRow[] = assessments.map((assessment) => {
    const marks: { enrollmentId: string; mark: number }[] = [];
    for (const result of assessment.results) {
      const value = result.mark !== null ? Number(result.mark) : 0;
      const totals = totalsByEnrollment.get(result.enrollmentId);
      if (totals) {
        totals.earned += value;
        totals.possible += Number(assessment.maximumMarks);
      }
      marks.push({ enrollmentId: result.enrollmentId, mark: value });
    }

    let top: AssessmentBreakdownRow["top"] = null;
    let lowest: AssessmentBreakdownRow["lowest"] = null;
    for (const m of marks) {
      const studentName = studentNameByEnrollment.get(m.enrollmentId) ?? "Unknown";
      if (!top || m.mark > top.mark) top = { studentName, mark: m.mark };
      if (!lowest || m.mark < lowest.mark) lowest = { studentName, mark: m.mark };
    }

    return {
      assessmentId: assessment.id,
      title: assessment.title,
      typeName: assessment.assessmentType.name,
      maximumMarks: Number(assessment.maximumMarks),
      status: assessment.status,
      gradedCount: marks.length,
      average: marks.length
        ? marks.reduce((sum, m) => sum + m.mark, 0) / marks.length
        : null,
      top,
      lowest,
    };
  });

  const studentTotals: StudentTotal[] = enrollments.map((enrollment) => {
    const totals = totalsByEnrollment.get(enrollment.id)!;
    return {
      enrollmentId: enrollment.id,
      studentNo: enrollment.student.studentNo,
      studentName: enrollment.student.fullName,
      earned: totals.earned,
      possible: totals.possible,
      percentage: totals.possible > 0 ? (totals.earned / totals.possible) * 100 : null,
    };
  });

  const ranked = studentTotals.filter(
    (s): s is StudentTotal & { percentage: number } => s.percentage !== null
  );
  const classAverage = ranked.length
    ? ranked.reduce((sum, s) => sum + s.percentage, 0) / ranked.length
    : null;
  const top = ranked.length
    ? ranked.reduce((a, b) => (b.percentage > a.percentage ? b : a))
    : null;
  const lowest = ranked.length
    ? ranked.reduce((a, b) => (b.percentage < a.percentage ? b : a))
    : null;

  return { assignment, studentTotals, classAverage, top, lowest, breakdown };
}

export interface ClassReportCourseRow {
  assignmentId: string;
  courseName: string;
  lecturerName: string;
  studentCount: number;
  classAverage: number | null;
}

export async function getClassReport(
  classId: string,
  semesterId: string,
  departmentIds: string[]
) {
  // The scope check IS the query: a class outside this dean's overseen
  // departments simply doesn't come back.
  const [cls, semester] = await Promise.all([
    prisma.class.findFirst({
      where: { id: classId, ...classDeanWhere(departmentIds) },
      include: { program: true },
    }),
    prisma.semester.findUnique({
      where: { id: semesterId },
      include: { academicYear: true },
    }),
  ]);
  if (!cls || !semester) return null;

  const assignments = await prisma.lecturerCourseAssignment.findMany({
    where: { classId, semesterId },
    include: { course: true, lecturer: { include: { user: true } } },
    orderBy: { course: { name: "asc" } },
  });

  const courses: ClassReportCourseRow[] = await Promise.all(
    assignments.map(async (assignment) => {
      const report = await getCourseReport(assignment.id, departmentIds);
      return {
        assignmentId: assignment.id,
        courseName: assignment.course.name,
        lecturerName: assignment.lecturer.user.fullName,
        studentCount: report?.studentTotals.length ?? 0,
        classAverage: report?.classAverage ?? null,
      };
    })
  );

  return { class: cls, semester, courses };
}

export interface StudentHistoryRow {
  enrollmentId: string;
  courseName: string;
  className: string;
  semesterName: string;
  status: string;
  earned: number;
  possible: number;
  percentage: number | null;
}

export async function getStudentReport(
  studentId: string,
  departmentIds: string[]
) {
  // The scope check IS the query: a student whose CURRENT class is outside
  // this dean's overseen departments simply doesn't come back.
  const student = await prisma.student.findFirst({
    where: { id: studentId, ...studentDeanWhere(departmentIds) },
    include: { class: true },
  });
  if (!student) return null;

  // History is also scoped per-enrollment (not just via the student's
  // current class): "everything under those classes" means a past
  // enrollment under a class outside this dean's departments — e.g. before
  // a transfer in from another faculty — stays invisible even though the
  // student themselves is now in scope.
  const enrollments = await prisma.studentCourseEnrollment.findMany({
    where: { studentId, ...enrollmentDeanWhere(departmentIds) },
    include: {
      course: true,
      class: true,
      semester: { include: { academicYear: true } },
    },
    orderBy: [{ semester: { startDate: "desc" } }, { course: { name: "asc" } }],
  });

  const publishedResults = enrollments.length
    ? await prisma.assessmentResult.findMany({
        where: {
          enrollmentId: { in: enrollments.map((e) => e.id) },
          status: "PUBLISHED",
        },
        include: { assessment: { select: { maximumMarks: true } } },
      })
    : [];

  const resultsByEnrollment = new Map<string, typeof publishedResults>();
  for (const result of publishedResults) {
    resultsByEnrollment.set(result.enrollmentId, [
      ...(resultsByEnrollment.get(result.enrollmentId) ?? []),
      result,
    ]);
  }

  const history: StudentHistoryRow[] = enrollments.map((enrollment) => {
    const results = resultsByEnrollment.get(enrollment.id) ?? [];
    const earned = results.reduce(
      (sum, r) => sum + (r.mark !== null ? Number(r.mark) : 0),
      0
    );
    const possible = results.reduce(
      (sum, r) => sum + Number(r.assessment.maximumMarks),
      0
    );
    return {
      enrollmentId: enrollment.id,
      courseName: enrollment.course.name,
      className: enrollment.class.name,
      semesterName: `${enrollment.semester.name} (${enrollment.semester.academicYear.name})`,
      status: enrollment.status,
      earned,
      possible,
      percentage: possible > 0 ? (earned / possible) * 100 : null,
    };
  });

  return { student, history };
}
