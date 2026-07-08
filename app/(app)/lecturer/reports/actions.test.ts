import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLecturer = { id: "user-1" };

vi.mock("@/lib/auth", () => ({
  requireRole: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    lecturerCourseAssignment: { findFirst: vi.fn() },
    studentCourseEnrollment: { findMany: vi.fn() },
    assessment: { findMany: vi.fn() },
    studentGroup: { findMany: vi.fn() },
  },
}));

import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fetchClassResultReport, exportClassResultReport } from "./actions";

describe("lecturer reports actions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requireRole).mockResolvedValue(mockLecturer as never);
  });

  it("fetchClassResultReport enforces LECTURER-only access before querying anything", async () => {
    vi.mocked(requireRole).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(fetchClassResultReport("assign-1")).rejects.toThrow("FORBIDDEN");
    expect(prisma.lecturerCourseAssignment.findFirst).not.toHaveBeenCalled();
  });

  it("fetchClassResultReport scopes the lookup to the authenticated lecturer, not a trusted param", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue(null);

    const result = await fetchClassResultReport("someone-elses-assignment");

    expect(prisma.lecturerCourseAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "someone-elses-assignment", lecturer: { userId: "user-1" } },
      })
    );
    expect(result).toBeNull();
  });

  it("exportClassResultReport throws NOT_FOUND rather than exporting another lecturer's course", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue(null);

    await expect(exportClassResultReport("someone-elses-assignment")).rejects.toThrow(
      "NOT_FOUND"
    );
  });
});
