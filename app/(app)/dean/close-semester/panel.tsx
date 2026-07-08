import { prisma } from "@/lib/db";
import { CloseSemesterClient } from "./close-semester-client";

export async function CloseSemesterPanel() {
  const activeSemester = await prisma.semester.findFirst({
    where: { isActive: true },
    include: { academicYear: true },
  });

  let counts = { total: 0, draft: 0, published: 0 };
  if (activeSemester) {
    const assessments = await prisma.assessment.findMany({
      where: { assignment: { semesterId: activeSemester.id }, deletedAt: null },
      select: { status: true },
    });
    counts = {
      total: assessments.length,
      draft: assessments.filter((a) => a.status === "DRAFT").length,
      published: assessments.filter((a) => a.status === "PUBLISHED").length,
    };
  }

  return <CloseSemesterClient semester={activeSemester} counts={counts} />;
}
