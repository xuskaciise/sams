import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    lecturerCourseAssignment: { findUniqueOrThrow: vi.fn() },
    assessment: { create: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
  requireAssessmentOwner: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { requirePermission, requireAssessmentOwner } from "@/lib/auth";
import { createAssessment, updateAssessment } from "./actions";

const input = {
  title: "Final Exam",
  assessmentTypeId: "type-1",
  maximumMarks: 50,
  mode: "INDIVIDUAL" as const,
  examPhase: "FINAL" as const,
};

describe("assessment examPhase", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue({ id: "user-1" } as never);
  });

  it("persists examPhase on create", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findUniqueOrThrow).mockResolvedValue({
      lecturer: { userId: "user-1" },
      semester: { isClosed: false },
    } as never);
    await createAssessment("assign-1", input);
    expect(prisma.assessment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ examPhase: "FINAL" }),
    });
  });

  it("rejects an invalid examPhase", async () => {
    await expect(
      createAssessment("assign-1", { ...input, examPhase: "QUIZ" as never })
    ).rejects.toThrow();
    expect(prisma.assessment.create).not.toHaveBeenCalled();
  });

  it("persists examPhase on update of a DRAFT assessment", async () => {
    vi.mocked(requireAssessmentOwner).mockResolvedValue({
      assessment: { id: "a1", assignmentId: "assign-1", status: "DRAFT" },
    } as never);
    await updateAssessment("a1", input);
    expect(prisma.assessment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ examPhase: "FINAL" }),
      })
    );
  });

  it("still refuses to edit a non-DRAFT assessment", async () => {
    vi.mocked(requireAssessmentOwner).mockResolvedValue({
      assessment: { id: "a1", assignmentId: "assign-1", status: "PUBLISHED" },
    } as never);
    await expect(updateAssessment("a1", input)).rejects.toThrow("NOT_EDITABLE");
    expect(prisma.assessment.update).not.toHaveBeenCalled();
  });
});
