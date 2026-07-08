import { prisma } from "@/lib/db";
import { SemestersClient } from "./semesters-client";

export async function SemestersPanel() {
  const [semesters, academicYears, classesWithPlans, lecturers, previousActiveSemester] =
    await Promise.all([
      prisma.semester.findMany({
        include: { academicYear: true },
        orderBy: { startDate: "desc" },
      }),
      prisma.academicYear.findMany({
        orderBy: { name: "asc" },
      }),
      prisma.class.findMany({
        where: {
          deletedAt: null,
          currentSemesterNumber: { not: null },
          coursePlans: { some: {} },
        },
        include: {
          coursePlans: {
            include: { course: true },
            orderBy: [{ semesterNumber: "asc" }, { course: { name: "asc" } }],
          },
        },
        orderBy: { name: "asc" },
      }),
      prisma.lecturer.findMany({
        include: { user: true },
        orderBy: { user: { fullName: "asc" } },
      }),
      prisma.semester.findFirst({ where: { isActive: true } }),
    ]);

  const participatingClassIds = previousActiveSemester
    ? new Set(
        (
          await prisma.lecturerCourseAssignment.findMany({
            where: { semesterId: previousActiveSemester.id },
            select: { classId: true },
            distinct: ["classId"],
          })
        ).map((a) => a.classId)
      )
    : new Set<string>();

  return (
    <SemestersClient
      semesters={semesters}
      academicYears={academicYears}
      classesWithPlans={classesWithPlans}
      lecturers={lecturers}
      previousActiveSemester={previousActiveSemester}
      participatingClassIds={[...participatingClassIds]}
    />
  );
}
