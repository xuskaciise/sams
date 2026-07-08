import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLecturerUser = { id: "lecturer-user-1" };

vi.mock("@/lib/auth", () => ({
  requireAssessmentOwner: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    lecturerCourseAssignment: { findUniqueOrThrow: vi.fn() },
    studentCourseEnrollment: { findMany: vi.fn() },
    groupMember: { findMany: vi.fn() },
    assessmentResult: { upsert: vi.fn() },
    $transaction: vi.fn(async (arg) => Promise.all(arg)),
  },
}));

import { requireAssessmentOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { applySameMarkToGroup } from "./group-actions";

const draftAssessment = {
  id: "assessment-1",
  status: "DRAFT",
  maximumMarks: 20,
  assignmentId: "assignment-1",
};

describe("applySameMarkToGroup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requireAssessmentOwner).mockResolvedValue({
      user: mockLecturerUser,
      assessment: draftAssessment,
    } as never);
    vi.mocked(prisma.lecturerCourseAssignment.findUniqueOrThrow).mockResolvedValue({
      id: "assignment-1",
      courseId: "course-1",
      classId: "class-1",
      semesterId: "sem-1",
    } as never);
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([
      { id: "enr-1", studentId: "student-1" },
      { id: "enr-2", studentId: "student-2" },
    ] as never);
    vi.mocked(prisma.groupMember.findMany).mockResolvedValue([
      { id: "m1", groupId: "group-1", studentId: "student-1" },
      { id: "m2", groupId: "group-1", studentId: "student-2" },
    ] as never);
    vi.mocked(prisma.assessmentResult.upsert).mockResolvedValue({} as never);
  });

  it("blocks once the assessment is no longer DRAFT", async () => {
    vi.mocked(requireAssessmentOwner).mockResolvedValue({
      user: mockLecturerUser,
      assessment: { ...draftAssessment, status: "PUBLISHED" },
    } as never);

    await expect(
      applySameMarkToGroup("assessment-1", "group-1", {
        mark: 15,
        attendanceByStudentId: {},
      })
    ).rejects.toThrow("NOT_EDITABLE");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a mark outside 0..maximumMarks", async () => {
    await expect(
      applySameMarkToGroup("assessment-1", "group-1", {
        mark: 25,
        attendanceByStudentId: {},
      })
    ).rejects.toThrow("MARK_OUT_OF_RANGE");
  });

  it("snapshots the shared mark to every PRESENT member, in one transaction, with groupId set", async () => {
    await applySameMarkToGroup("assessment-1", "group-1", {
      mark: 18,
      attendanceByStudentId: { "student-1": "PRESENT", "student-2": "PRESENT" },
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.assessmentResult.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.assessmentResult.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          assessmentId_enrollmentId: { assessmentId: "assessment-1", enrollmentId: "enr-1" },
        },
        update: expect.objectContaining({ mark: 18, attendanceStatus: "PRESENT", groupId: "group-1" }),
        create: expect.objectContaining({ mark: 18, attendanceStatus: "PRESENT", groupId: "group-1" }),
      })
    );
  });

  it("gives an ABSENT/EXEMPT member a null mark instead of the shared value, while still recording their attendance and groupId", async () => {
    await applySameMarkToGroup("assessment-1", "group-1", {
      mark: 18,
      attendanceByStudentId: { "student-1": "PRESENT", "student-2": "ABSENT" },
    });

    expect(prisma.assessmentResult.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          assessmentId_enrollmentId: { assessmentId: "assessment-1", enrollmentId: "enr-2" },
        },
        update: expect.objectContaining({ mark: null, attendanceStatus: "ABSENT", groupId: "group-1" }),
      })
    );
  });

  it("defaults a member's attendance to PRESENT when not specified", async () => {
    await applySameMarkToGroup("assessment-1", "group-1", {
      mark: 10,
      attendanceByStudentId: {},
    });

    expect(prisma.assessmentResult.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ mark: 10, attendanceStatus: "PRESENT" }),
      })
    );
  });

  it("skips a group member who has no active enrollment instead of erroring", async () => {
    vi.mocked(prisma.groupMember.findMany).mockResolvedValue([
      { id: "m1", groupId: "group-1", studentId: "student-1" },
      { id: "m3", groupId: "group-1", studentId: "student-not-enrolled" },
    ] as never);

    await applySameMarkToGroup("assessment-1", "group-1", {
      mark: 10,
      attendanceByStudentId: {},
    });

    expect(prisma.assessmentResult.upsert).toHaveBeenCalledTimes(1);
  });
});
