import { prisma } from "@/lib/db";

export async function getAssessmentWithContext(assessmentId: string) {
  return prisma.assessment.findUnique({
    where: { id: assessmentId, deletedAt: null },
    include: {
      assessmentType: true,
      assignment: {
        include: {
          lecturer: true,
          course: true,
          class: true,
          semester: { include: { academicYear: true } },
        },
      },
    },
  });
}

export async function getActiveEnrollments(assignment: {
  courseId: string;
  classId: string;
  semesterId: string;
}) {
  return prisma.studentCourseEnrollment.findMany({
    where: {
      courseId: assignment.courseId,
      classId: assignment.classId,
      semesterId: assignment.semesterId,
      status: "ACTIVE",
    },
    include: { student: true },
    orderBy: { student: { fullName: "asc" } },
  });
}
