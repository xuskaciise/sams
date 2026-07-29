import { describe, it, expect, vi, beforeEach } from "vitest";

const mockUser = { id: "user-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
  requireAssessmentOwner: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    assessment: { update: vi.fn() },
    assessmentResult: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/whatsapp-notify", () => ({
  notifyResultsPublished: vi.fn(),
}));

import { requirePermission, requireAssessmentOwner } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { notifyResultsPublished } from "@/lib/whatsapp-notify";
import { publishAssessment } from "./actions";

describe("publishAssessment", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(requireAssessmentOwner).mockResolvedValue({
      user: mockUser,
      assessment: { id: "assessment-1", status: "DRAFT" },
    } as never);
    vi.mocked(prisma.$transaction).mockResolvedValue([{}, {}] as never);
  });

  it("enforces assessment.publish and ownership before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(publishAssessment("assessment-1")).rejects.toThrow("FORBIDDEN");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(notifyResultsPublished).not.toHaveBeenCalled();
  });

  it("rejects publishing an assessment that isn't DRAFT", async () => {
    vi.mocked(requireAssessmentOwner).mockResolvedValue({
      user: mockUser,
      assessment: { id: "assessment-1", status: "PUBLISHED" },
    } as never);

    await expect(publishAssessment("assessment-1")).rejects.toThrow("NOT_DRAFT");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(notifyResultsPublished).not.toHaveBeenCalled();
  });

  it("publishes, audits RESULTS_PUBLISHED, and triggers the best-effort WhatsApp notification", async () => {
    await publishAssessment("assessment-1");

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        action: "RESULTS_PUBLISHED",
        entity: "Assessment",
        entityId: "assessment-1",
      })
    );
    expect(notifyResultsPublished).toHaveBeenCalledWith("assessment-1");
  });
});
