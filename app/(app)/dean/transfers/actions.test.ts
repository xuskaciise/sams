import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDean = { id: "dean-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    lecturerCourseAssignment: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    lecturer: { findUniqueOrThrow: vi.fn() },
    assessment: { findMany: vi.fn() },
    ownershipTransfer: { create: vi.fn() },
    $transaction: vi.fn(async (arg) => Promise.all(arg)),
  },
}));

import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { transferOwnership } from "./actions";

const oldLecturer = {
  id: "lect-old",
  userId: "user-old",
  user: { fullName: "Dr. Old" },
};
const newLecturer = {
  id: "lect-new",
  userId: "user-new",
  user: { fullName: "Dr. New" },
};

describe("transferOwnership", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockDean as never);
    vi.mocked(prisma.lecturerCourseAssignment.findUniqueOrThrow).mockResolvedValue({
      id: "assign-1",
      lecturerId: oldLecturer.id,
      lecturer: oldLecturer,
      semester: { id: "sem-1", isClosed: false },
    } as never);
    vi.mocked(prisma.lecturer.findUniqueOrThrow).mockResolvedValue(newLecturer as never);
    vi.mocked(prisma.assessment.findMany).mockResolvedValue([
      { id: "assessment-1" },
      { id: "assessment-2" },
    ] as never);
  });

  it("enforces DEAN-only access before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(
      transferOwnership("assign-1", { newLecturerId: "lect-new", reason: "leave" })
    ).rejects.toThrow("FORBIDDEN");
    expect(prisma.lecturerCourseAssignment.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("refuses to transfer an assignment in a closed semester", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findUniqueOrThrow).mockResolvedValue({
      id: "assign-1",
      lecturerId: oldLecturer.id,
      lecturer: oldLecturer,
      semester: { id: "sem-1", isClosed: true },
    } as never);

    await expect(
      transferOwnership("assign-1", { newLecturerId: "lect-new", reason: "leave" })
    ).rejects.toThrow("CLOSED_SEMESTER");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a no-op transfer to the same lecturer", async () => {
    await expect(
      transferOwnership("assign-1", { newLecturerId: oldLecturer.id, reason: "leave" })
    ).rejects.toThrow("SAME_LECTURER");
  });

  it("reassigns the assignment's lecturer and creates one ownership_transfers row per existing assessment, in one transaction", async () => {
    await transferOwnership("assign-1", {
      newLecturerId: "lect-new",
      reason: "Lecturer on leave",
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.lecturerCourseAssignment.update).toHaveBeenCalledWith({
      where: { id: "assign-1" },
      data: { lecturerId: "lect-new" },
    });
    expect(prisma.ownershipTransfer.create).toHaveBeenCalledTimes(2);
    expect(prisma.ownershipTransfer.create).toHaveBeenCalledWith({
      data: {
        assessmentId: "assessment-1",
        fromLecturer: "user-old",
        toLecturer: "user-new",
        transferredBy: "dean-1",
        reason: "Lecturer on leave",
      },
    });
  });

  it("audits OWNERSHIP_TRANSFERRED with the reason and affected count", async () => {
    await transferOwnership("assign-1", {
      newLecturerId: "lect-new",
      reason: "Lecturer on leave",
    });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "dean-1",
        action: "OWNERSHIP_TRANSFERRED",
        entity: "LecturerCourseAssignment",
        entityId: "assign-1",
        newValue: expect.objectContaining({
          lecturerId: "lect-new",
          reason: "Lecturer on leave",
          assessmentsAffected: 2,
        }),
      })
    );
  });

  it("still reassigns the assignment lecturer when it has zero assessments yet", async () => {
    vi.mocked(prisma.assessment.findMany).mockResolvedValue([]);

    await transferOwnership("assign-1", { newLecturerId: "lect-new", reason: "reason" });

    expect(prisma.lecturerCourseAssignment.update).toHaveBeenCalled();
    expect(prisma.ownershipTransfer.create).not.toHaveBeenCalled();
  });
});
