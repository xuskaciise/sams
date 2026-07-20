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
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    lecturer: { findFirst: vi.fn() },
    assessment: { findMany: vi.fn() },
    ownershipTransfer: { create: vi.fn() },
    deanDepartment: { findMany: vi.fn() },
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

function mockDeanDepartments(ids: string[]) {
  vi.mocked(prisma.deanDepartment.findMany).mockResolvedValue(
    ids.map((departmentId) => ({ departmentId })) as never
  );
}

describe("transferOwnership", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockDean as never);
    mockDeanDepartments(["dept-cs"]);
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue({
      id: "assign-1",
      lecturerId: oldLecturer.id,
      lecturer: oldLecturer,
      semester: { id: "sem-1", isClosed: false },
    } as never);
    vi.mocked(prisma.lecturer.findFirst).mockResolvedValue(newLecturer as never);
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
    expect(prisma.lecturerCourseAssignment.findFirst).not.toHaveBeenCalled();
  });

  it("scopes the assignment lookup to the dean's overseen departments", async () => {
    await transferOwnership("assign-1", { newLecturerId: "lect-new", reason: "leave" });

    expect(prisma.lecturerCourseAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "assign-1",
          class: { program: { departmentId: { in: ["dept-cs"] } } },
        },
      })
    );
  });

  it("a dean linked to two departments scopes the lookup to both", async () => {
    mockDeanDepartments(["dept-cs", "dept-eng"]);

    await transferOwnership("assign-1", { newLecturerId: "lect-new", reason: "leave" });

    expect(prisma.lecturerCourseAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          class: { program: { departmentId: { in: ["dept-cs", "dept-eng"] } } },
        }),
      })
    );
  });

  it("refuses to transfer an assignment outside the dean's departments (not just not found — out of scope)", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue(null);

    await expect(
      transferOwnership("assign-other-faculty", {
        newLecturerId: "lect-new",
        reason: "leave",
      })
    ).rejects.toThrow("NOT_FOUND");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("an unassigned dean (no departments) can never find any assignment", async () => {
    mockDeanDepartments([]);
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue(null);

    await expect(
      transferOwnership("assign-1", { newLecturerId: "lect-new", reason: "leave" })
    ).rejects.toThrow("NOT_FOUND");
    expect(prisma.lecturerCourseAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          class: { program: { departmentId: { in: [] } } },
        }),
      })
    );
  });

  it("refuses a new lecturer outside the dean's visible pool", async () => {
    vi.mocked(prisma.lecturer.findFirst).mockResolvedValue(null);

    await expect(
      transferOwnership("assign-1", { newLecturerId: "lect-outside", reason: "leave" })
    ).rejects.toThrow("LECTURER_NOT_FOUND");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses to transfer an assignment in a closed semester", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue({
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
