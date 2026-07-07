import { prisma } from "@/lib/db";

export async function getGroupsForAssignment(assignmentId: string) {
  return prisma.studentGroup.findMany({
    where: { assignmentId },
    include: {
      members: { include: { student: true } },
    },
    orderBy: { name: "asc" },
  });
}

export async function getActiveEnrollmentsForAssignment(assignment: {
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
