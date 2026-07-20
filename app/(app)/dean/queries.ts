import { prisma } from "@/lib/db";
import { assignmentDeanWhere } from "@/lib/dean-scope";

export interface DeanAssessmentCounts {
  total: number;
  draft: number;
  published: number;
}

// Scoped the same way as every other dean query: an unassigned dean
// (empty departmentIds) gets the zeroed shape without ever hitting the DB —
// the dashboard's counts must never fall back to a global, unscoped count.
export async function getDeanAssessmentCounts(
  departmentIds: string[],
  semesterId: string
): Promise<DeanAssessmentCounts> {
  if (departmentIds.length === 0) {
    return { total: 0, draft: 0, published: 0 };
  }

  const assessments = await prisma.assessment.findMany({
    where: {
      deletedAt: null,
      assignment: { semesterId, ...assignmentDeanWhere(departmentIds) },
    },
    select: { status: true },
  });

  return {
    total: assessments.length,
    draft: assessments.filter((a) => a.status === "DRAFT").length,
    published: assessments.filter((a) => a.status === "PUBLISHED").length,
  };
}
