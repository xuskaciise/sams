import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAdmin = { id: "admin-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    studentCourseEnrollment: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { restoreEnrollment } from "./actions";

describe("restoreEnrollment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
  });

  it("refuses to restore an enrollment that isn't DROPPED", async () => {
    vi.mocked(prisma.studentCourseEnrollment.findUniqueOrThrow).mockResolvedValue(
      { id: "enr-1", status: "ACTIVE" } as never
    );

    await expect(restoreEnrollment("enr-1")).rejects.toThrow("NOT_DROPPED");
    expect(prisma.studentCourseEnrollment.update).not.toHaveBeenCalled();
  });

  it("restores a DROPPED enrollment back to ACTIVE", async () => {
    vi.mocked(prisma.studentCourseEnrollment.findUniqueOrThrow).mockResolvedValue(
      { id: "enr-1", status: "DROPPED" } as never
    );

    await restoreEnrollment("enr-1");

    expect(prisma.studentCourseEnrollment.update).toHaveBeenCalledWith({
      where: { id: "enr-1" },
      data: { status: "ACTIVE" },
    });
  });

  it("enforces admin-only access", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(restoreEnrollment("enr-1")).rejects.toThrow("FORBIDDEN");
    expect(prisma.studentCourseEnrollment.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});
