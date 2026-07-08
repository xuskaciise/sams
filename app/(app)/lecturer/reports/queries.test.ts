import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    lecturerCourseAssignment: { findFirst: vi.fn() },
    studentCourseEnrollment: { findMany: vi.fn() },
    assessment: { findMany: vi.fn() },
    studentGroup: { findMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import { getClassResultReport } from "./queries";

const assignment = {
  id: "assign-1",
  courseId: "course-1",
  classId: "class-1",
  semesterId: "sem-1",
  course: { name: "Databases" },
  class: { name: "CMS2518-A-FT" },
  semester: { name: "Semester 1", academicYear: { name: "2025-2026" } },
};

const enrollments = [
  { id: "enr-1", studentId: "student-1", student: { studentNo: "S1", fullName: "Alice" } },
  { id: "enr-2", studentId: "student-2", student: { studentNo: "S2", fullName: "Bob" } },
];

describe("getClassResultReport", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue(
      enrollments as never
    );
    vi.mocked(prisma.assessment.findMany).mockResolvedValue([]);
    vi.mocked(prisma.studentGroup.findMany).mockResolvedValue([]);
  });

  it("scopes the assignment lookup to this lecturer's userId — another lecturer's assignment id returns null", async () => {
    // This IS the ownership defense against URL manipulation: the where
    // clause ties the lookup to the session's lecturer, so an assignment
    // id belonging to a different lecturer simply never matches.
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue(null);

    const result = await getClassResultReport("user-a", "someone-elses-assignment");

    expect(prisma.lecturerCourseAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "someone-elses-assignment", lecturer: { userId: "user-a" } },
      })
    );
    expect(result).toBeNull();
    expect(prisma.assessment.findMany).not.toHaveBeenCalled();
  });

  it("only ever selects PUBLISHED results when building the matrix", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue(
      assignment as never
    );

    await getClassResultReport("user-1", "assign-1");

    expect(prisma.assessment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { assignmentId: "assign-1", deletedAt: null },
        include: expect.objectContaining({
          results: { where: { status: "PUBLISHED" } },
        }),
      })
    );
  });

  it("builds a per-student matrix from published results, treating a still-draft assessment as an empty cell for everyone", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue(
      assignment as never
    );
    vi.mocked(prisma.assessment.findMany).mockResolvedValue([
      {
        id: "a1",
        title: "Quiz 1",
        status: "PUBLISHED",
        maximumMarks: 20,
        assessmentType: { name: "Quiz" },
        results: [
          { enrollmentId: "enr-1", mark: 18, attendanceStatus: "PRESENT", isCorrected: false },
        ],
      },
      {
        id: "a2",
        title: "Quiz 2 (ungraded draft)",
        status: "DRAFT",
        maximumMarks: 20,
        assessmentType: { name: "Quiz" },
        results: [],
      },
    ] as never);

    const report = await getClassResultReport("user-1", "assign-1");

    const alice = report?.students.find((s) => s.enrollmentId === "enr-1");
    expect(alice?.marks["a1"]).toMatchObject({ mark: 18 });
    expect(alice?.marks["a2"]).toBeNull();
    expect(alice?.earned).toBe(18);
    expect(alice?.possible).toBe(20);

    const bob = report?.students.find((s) => s.enrollmentId === "enr-2");
    expect(bob?.marks["a1"]).toBeNull();
    expect(bob?.earned).toBe(0);
    expect(bob?.possible).toBe(0);
    expect(bob?.percentage).toBeNull();
  });

  it("attaches each student's group from assignment-scoped group membership", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue(
      assignment as never
    );
    vi.mocked(prisma.studentGroup.findMany).mockResolvedValue([
      {
        id: "group-1",
        name: "Group A",
        members: [{ studentId: "student-1" }],
      },
    ] as never);

    const report = await getClassResultReport("user-1", "assign-1");

    const alice = report?.students.find((s) => s.enrollmentId === "enr-1");
    const bob = report?.students.find((s) => s.enrollmentId === "enr-2");
    expect(alice).toMatchObject({ groupId: "group-1", groupName: "Group A" });
    expect(bob).toMatchObject({ groupId: null, groupName: null });
    expect(report?.groups).toEqual([{ id: "group-1", name: "Group A" }]);
  });
});
