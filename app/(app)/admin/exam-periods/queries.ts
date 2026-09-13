import { prisma } from "@/lib/db";

// University-wide, ADMIN-only — no dean scoping anywhere in this module
// (see the "Special Exam Period management" business rule in CLAUDE.md).
export async function getExamPeriodsPanelData() {
  const [periods, academicYears] = await Promise.all([
    prisma.specialExamPeriod.findMany({
      include: {
        academicYear: true,
        semester: true,
        createdBy: { select: { fullName: true } },
        _count: { select: { records: true } },
      },
      orderBy: [
        { academicYear: { startDate: "desc" } },
        { semester: { semesterNumber: "asc" } },
      ],
    }),
    prisma.academicYear.findMany({
      include: { semesters: { orderBy: { semesterNumber: "asc" } } },
      orderBy: { startDate: "desc" },
    }),
  ]);
  return { periods, academicYears };
}

export type ExamPeriodsPanelData = Awaited<ReturnType<typeof getExamPeriodsPanelData>>;
