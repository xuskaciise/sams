import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDean = { id: "dean-1" };

vi.mock("@/lib/auth", () => ({
  requireRole: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    semester: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
    assessment: { findMany: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(async (arg) => Promise.all(arg)),
  },
}));

import { requireRole } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { closeSemester } from "./actions";

describe("closeSemester", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requireRole).mockResolvedValue(mockDean as never);
    vi.mocked(prisma.semester.findUniqueOrThrow).mockResolvedValue({
      id: "sem-1",
      isClosed: false,
      isActive: true,
    } as never);
    vi.mocked(prisma.assessment.findMany).mockResolvedValue([
      { id: "a1", status: "DRAFT" },
      { id: "a2", status: "PUBLISHED" },
      { id: "a3", status: "DRAFT" },
    ] as never);
  });

  it("enforces DEAN-only access before touching anything", async () => {
    vi.mocked(requireRole).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(closeSemester("sem-1")).rejects.toThrow("FORBIDDEN");
    expect(prisma.semester.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("refuses to close an already-closed semester", async () => {
    vi.mocked(prisma.semester.findUniqueOrThrow).mockResolvedValue({
      id: "sem-1",
      isClosed: true,
      isActive: true,
    } as never);

    await expect(closeSemester("sem-1")).rejects.toThrow("ALREADY_CLOSED");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses to close a semester that isn't the active one", async () => {
    vi.mocked(prisma.semester.findUniqueOrThrow).mockResolvedValue({
      id: "sem-1",
      isClosed: false,
      isActive: false,
    } as never);

    await expect(closeSemester("sem-1")).rejects.toThrow("NOT_ACTIVE");
  });

  it("marks the semester closed and every DRAFT/PUBLISHED assessment CLOSED, in one transaction", async () => {
    await closeSemester("sem-1");

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.semester.update).toHaveBeenCalledWith({
      where: { id: "sem-1" },
      data: { isClosed: true },
    });
    expect(prisma.assessment.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["a1", "a2", "a3"] } },
      data: { status: "CLOSED" },
    });
    expect(prisma.assessment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          assignment: { semesterId: "sem-1" },
          deletedAt: null,
          status: { in: ["DRAFT", "PUBLISHED"] },
        }),
      })
    );
  });

  it("audits SEMESTER_CLOSED with the closed count and the still-draft count at close time", async () => {
    await closeSemester("sem-1");

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "dean-1",
        action: "SEMESTER_CLOSED",
        entity: "Semester",
        entityId: "sem-1",
        newValue: { assessmentsClosed: 3, draftCountAtClose: 2 },
      })
    );
  });
});
