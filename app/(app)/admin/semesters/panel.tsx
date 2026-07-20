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

  // Only the currently active semester can ever be closed, so its
  // assessment counts are the only ones the close-confirmation dialog
  // needs.
  const activeSemester = semesters.find((s) => s.isActive) ?? null;
  let activeSemesterCounts = { total: 0, draft: 0, published: 0 };
  if (activeSemester) {
    const assessments = await prisma.assessment.findMany({
      where: { assignment: { semesterId: activeSemester.id }, deletedAt: null },
      select: { status: true },
    });
    activeSemesterCounts = {
      total: assessments.length,
      draft: assessments.filter((a) => a.status === "DRAFT").length,
      published: assessments.filter((a) => a.status === "PUBLISHED").length,
    };
  }

  return (
    <SemestersClient
      semesters={semesters}
      academicYears={academicYears}
      classesWithPlans={classesWithPlans}
      lecturers={lecturers}
      previousActiveSemester={previousActiveSemester}
      participatingClassIds={[...participatingClassIds]}
      activeSemesterCounts={activeSemesterCounts}
    />
  );
}
