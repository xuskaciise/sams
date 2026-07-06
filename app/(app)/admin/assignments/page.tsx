import { prisma } from "@/lib/db";
import { AssignmentsClient } from "./assignments-client";

export default async function AssignmentsPage() {
  const [assignments, lecturers, courses, classes, semesters] =
    await Promise.all([
      prisma.lecturerCourseAssignment.findMany({
        include: {
          lecturer: { include: { user: true } },
          course: true,
          class: true,
          semester: true,
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.lecturer.findMany({
        include: { user: true },
        where: { user: { deletedAt: null } },
        orderBy: { user: { fullName: "asc" } },
      }),
      prisma.course.findMany({
        where: { deletedAt: null },
        orderBy: { name: "asc" },
      }),
      prisma.class.findMany({
        where: { deletedAt: null },
        orderBy: { name: "asc" },
      }),
      prisma.semester.findMany({
        where: { isClosed: false },
        orderBy: { startDate: "desc" },
      }),
    ]);

  return (
    <AssignmentsClient
      assignments={assignments}
      lecturers={lecturers}
      courses={courses}
      classes={classes}
      semesters={semesters}
    />
  );
}
