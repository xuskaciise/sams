import { describe, it, expect, vi, beforeEach } from "vitest";

const mockUser = { id: "user-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    student: { findUnique: vi.fn() },
    studentCourseEnrollment: { findMany: vi.fn() },
    assessmentResult: { findMany: vi.fn() },
  },
}));

import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { exportMyResults } from "./actions";

describe("exportMyResults", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
  });

  it("enforces results.view.own before touching the database", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(exportMyResults()).rejects.toThrow("FORBIDDEN");
    expect(prisma.student.findUnique).not.toHaveBeenCalled();
  });

  it("resolves the student from the session userId, never a client-supplied id", async () => {
    vi.mocked(prisma.student.findUnique).mockResolvedValue({
      id: "student-1",
      studentNo: "S001",
    } as never);
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([]);

    await exportMyResults();

    expect(prisma.student.findUnique).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
    expect(prisma.studentCourseEnrollment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { studentId: "student-1" } })
    );
  });

  it("throws NOT_FOUND rather than exporting anything when the session user has no student profile", async () => {
    vi.mocked(prisma.student.findUnique).mockResolvedValue(null);

    await expect(exportMyResults()).rejects.toThrow("NOT_FOUND");
    expect(prisma.studentCourseEnrollment.findMany).not.toHaveBeenCalled();
  });

  it("only ever sums PUBLISHED results into the exported totals", async () => {
    vi.mocked(prisma.student.findUnique).mockResolvedValue({
      id: "student-1",
      studentNo: "S001",
    } as never);
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([
      { id: "enr-1", course: { name: "Databases", code: "DB101" }, class: { name: "CMS1-A-FT" }, semester: { name: "Semester 1", academicYear: { name: "2026-2027" } }, status: "ACTIVE" },
    ] as never);
    vi.mocked(prisma.assessmentResult.findMany).mockResolvedValue([]);

    await exportMyResults();

    expect(prisma.assessmentResult.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "PUBLISHED" }),
      })
    );
  });
});
