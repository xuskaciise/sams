import { prisma } from "@/lib/db";
import { EnrollmentsClient } from "./enrollments-client";

export default async function EnrollmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ classId?: string; courseId?: string }>;
}) {
  const { classId, courseId } = await searchParams;

  const [enrollments, students, courses, semesters, classes] =
    await Promise.all([
      prisma.studentCourseEnrollment.findMany({
        where: {
          ...(classId ? { classId } : {}),
          ...(courseId ? { courseId } : {}),
        },
        include: {
          student: true,
          course: true,
          class: true,
          semester: true,
        },
        orderBy: { enrolledAt: "desc" },
      }),
      prisma.student.findMany({
        where: { OR: [{ userId: null }, { user: { deletedAt: null } }] },
        orderBy: { fullName: "asc" },
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
      selectedClassId={classId ?? ""}
      selectedCourseId={courseId ?? ""}
    />
  );
}
