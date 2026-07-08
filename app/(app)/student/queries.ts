import { prisma } from "@/lib/db";

// Everything here is scoped by the session's own userId — never trust a
// studentId/enrollmentId that only came from a URL param without also
// filtering through the relation back to userId. This IS the security
// boundary for "students see only their own data" (CLAUDE.md rule #2/#4).

export async function getStudentDashboardData(userId: string) {
  const student = await prisma.student.findUnique({
    where: { userId },
    include: { class: true },
  });
  if (!student) return null;

  const activeSemester = await prisma.semester.findFirst({
    where: { isActive: true },
    include: { academicYear: true },
  });

  const enrollments = activeSemester
    ? await prisma.studentCourseEnrollment.findMany({
        where: {
          studentId: student.id,
          semesterId: activeSemester.id,
          status: "ACTIVE",
        },
        include: { course: true },
        orderBy: { course: { name: "asc" } },
      })
    : [];

  // Published-only — a draft mark must never be summed into a total a
  // student can see, even indirectly.
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

  const courses = enrollments.map((enrollment) => {
    const results = resultsByEnrollment.get(enrollment.id) ?? [];
    const earned = results.reduce(
      (sum, r) => sum + (r.mark !== null ? Number(r.mark) : 0),
      0
    );
    const possible = results.reduce(
      (sum, r) => sum + Number(r.assessment.maximumMarks),
      0
    );
    return { enrollment, earned, possible, gradedCount: results.length };
  });

  return { student, activeSemester, courses };
}

export async function getStudentCourseDetail(
  userId: string,
  enrollmentId: string
) {
  // The ownership check IS the query — an enrollment only ever comes back
  // if it belongs to this session's student. Returning null here (rather
  // than fetching first and checking after) is what stops student A from
  // reading student B's course page by guessing/editing the enrollment id
  // in the URL.
  const enrollment = await prisma.studentCourseEnrollment.findFirst({
    where: { id: enrollmentId, student: { userId } },
    include: { course: true, class: true, semester: true },
  });
  if (!enrollment) return null;

  const assignment = await prisma.lecturerCourseAssignment.findFirst({
    where: {
      courseId: enrollment.courseId,
      classId: enrollment.classId,
      semesterId: enrollment.semesterId,
    },
  });

  const assessments = assignment
    ? await prisma.assessment.findMany({
        where: { assignmentId: assignment.id, deletedAt: null },
        include: {
          assessmentType: true,
          // Scoped to THIS enrollment and PUBLISHED only. A draft result —
          // this student's or anyone else's — is never selected, so it
          // can't reach the client, leak into a total, or be inferred from
          // its absence vs presence (every row gets the same "no result"
          // shape whether it's actually a draft or truly ungraded).
          results: {
            where: { enrollmentId, status: "PUBLISHED" },
          },
        },
        orderBy: { createdAt: "asc" },
      })
    : [];

  return { enrollment, assessments };
}
