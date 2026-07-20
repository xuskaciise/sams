import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    assessment: { findMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import { getDeanAssessmentCounts } from "./queries";

describe("getDeanAssessmentCounts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("an unassigned dean (empty departmentIds) gets zeroed counts without querying the DB", async () => {
    const counts = await getDeanAssessmentCounts([], "sem-1");

    expect(counts).toEqual({ total: 0, draft: 0, published: 0 });
    expect(prisma.assessment.findMany).not.toHaveBeenCalled();
  });

  it("scopes the count query to the dean's overseen departments and the given semester", async () => {
    vi.mocked(prisma.assessment.findMany).mockResolvedValue([]);

    await getDeanAssessmentCounts(["dept-cs"], "sem-1");

    expect(prisma.assessment.findMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        assignment: {
          semesterId: "sem-1",
          class: { program: { departmentId: { in: ["dept-cs"] } } },
        },
      },
      select: { status: true },
    });
  });

  it("counts total/draft/published from only the scoped assessments", async () => {
    vi.mocked(prisma.assessment.findMany).mockResolvedValue([
      { status: "DRAFT" },
      { status: "DRAFT" },
      { status: "PUBLISHED" },
    ] as never);

    const counts = await getDeanAssessmentCounts(["dept-cs"], "sem-1");

    expect(counts).toEqual({ total: 3, draft: 2, published: 1 });
  });

  it("a dean linked to two departments scopes to both", async () => {
    vi.mocked(prisma.assessment.findMany).mockResolvedValue([]);

    await getDeanAssessmentCounts(["dept-cs", "dept-eng"], "sem-1");

    expect(prisma.assessment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          assignment: expect.objectContaining({
            class: { program: { departmentId: { in: ["dept-cs", "dept-eng"] } } },
          }),
        }),
      })
    );
  });
});
