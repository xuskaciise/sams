import { prisma } from "@/lib/db";
import { SemestersClient } from "./semesters-client";

export async function SemestersPanel() {
  const [semesters, academicYears, classesWithPlans, lecturers] =
    await Promise.all([
      prisma.semester.findMany({
        include: { academicYear: true },
        orderBy: { startDate: "desc" },
      }),
      prisma.academicYear.findMany({
        orderBy: { name: "asc" },
      }),
      prisma.class.findMany({
        where: { deletedAt: null, coursePlans: { some: {} } },
        include: {
          coursePlans: {
            include: { course: true },
            orderBy: { course: { name: "asc" } },
          },
        },
        orderBy: { name: "asc" },
      }),
      prisma.lecturer.findMany({
        include: { user: true },
        orderBy: { user: { fullName: "asc" } },
      }),
    ]);

  return (
    <SemestersClient
      semesters={semesters}
      academicYears={academicYears}
      classesWithPlans={classesWithPlans}
      lecturers={lecturers}
    />
  );
}
