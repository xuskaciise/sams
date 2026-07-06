import { prisma } from "@/lib/db";
import { EnrollmentsClient } from "./enrollments-client";

export default async function EnrollmentsPage() {
  const [enrollments, students, courses, semesters, classes] =
    await Promise.all([
      prisma.studentCourseEnrollment.findMany({
        include: {
          student: { include: { user: true } },
          course: true,
          class: true,
          semester: true,
        },
        orderBy: { enrolledAt: "desc" },
      }),
      prisma.student.findMany({
        include: { user: true },
        where: { user: { deletedAt: null } },
        orderBy: { user: { fullName: "asc" } },
      }),
      prisma.course.findMany({
        where: { deletedAt: null },
        orderBy: { name: "asc" },
      }),
      prisma.semester.findMany({
        where: { isClosed: false },
        orderBy: { startDate: "desc" },
      }),
      prisma.class.findMany({
        where: { deletedAt: null },
        orderBy: { name: "asc" },
      }),
    ]);

  return (
    <EnrollmentsClient
      enrollments={enrollments}
      students={students}
      courses={courses}
      semesters={semesters}
      classes={classes}
    />
  );
}
