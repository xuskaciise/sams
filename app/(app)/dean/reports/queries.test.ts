import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    lecturerCourseAssignment: { findUnique: vi.fn() },
    studentCourseEnrollment: { findMany: vi.fn() },
    assessment: { findMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import { getCourseReport } from "./queries";

const assignment = {
  id: "assign-1",
  courseId: "course-1",
  classId: "class-1",
  semesterId: "sem-1",
  lecturer: { user: { fullName: "Dr. Lecturer" } },
  course: { name: "Databases" },
  class: { name: "CMS2518-A-FT" },
  semester: { name: "Semester 1", academicYear: { name: "2025-2026" } },
};

const enrollments = [
  { id: "enr-1", student: { studentNo: "S1", fullName: "Alice" } },
  { id: "enr-2", student: { studentNo: "S2", fullName: "Bob" } },
];

describe("getCourseReport", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.lecturerCourseAssignment.findUnique).mockResolvedValue(
      assignment as never
    );
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue(
      enrollments as never
    );
  });

  it("returns null when the assignment doesn't exist", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findUnique).mockResolvedValue(null);

    expect(await getCourseReport("missing")).toBeNull();
    expect(prisma.assessment.findMany).not.toHaveBeenCalled();
  });

  it("only ever selects PUBLISHED results — the query itself is the draft guard", async () => {
    vi.mocked(prisma.assessment.findMany).mockResolvedValue([]);

    await getCourseReport("assign-1");

    expect(prisma.assessment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { assignmentId: "assign-1", deletedAt: null },
        include: expect.objectContaining({
          results: { where: { status: "PUBLISHED" } },
        }),
      })
    );
  });

  it("computes per-student earned/possible/percentage from published results only, and identifies top/lowest", async () => {
    vi.mocked(prisma.assessment.findMany).mockResolvedValue([
      {
        id: "assessment-1",
        title: "Quiz 1",
        status: "PUBLISHED",
        maximumMarks: 20,
        assessmentType: { name: "Quiz" },
        results: [
          { enrollmentId: "enr-1", mark: 18 },
          { enrollmentId: "enr-2", mark: 10 },
        ],
      },
      {
        // Still draft: no published results at all, so it must not move
        // any student's total and must show up with null/zero stats.
        id: "assessment-2",
        title: "Quiz 2 (ungraded)",
        status: "DRAFT",
        maximumMarks: 20,
        assessmentType: { name: "Quiz" },
        results: [],
      },
    ] as never);

    const report = await getCourseReport("assign-1");

    expect(report?.studentTotals).toEqual([
      {
        enrollmentId: "enr-1",
        studentNo: "S1",
        studentName: "Alice",
        earned: 18,
        possible: 20,
        percentage: 90,
      },
      {
        enrollmentId: "enr-2",
        studentNo: "S2",
        studentName: "Bob",
        earned: 10,
        possible: 20,
        percentage: 50,
      },
    ]);
    expect(report?.classAverage).toBe(70);
    expect(report?.top).toMatchObject({ studentName: "Alice", percentage: 90 });
    expect(report?.lowest).toMatchObject({ studentName: "Bob", percentage: 50 });

    const draftBreakdown = report?.breakdown.find((b) => b.assessmentId === "assessment-2");
    expect(draftBreakdown).toMatchObject({
      gradedCount: 0,
      average: null,
      top: null,
      lowest: null,
    });
  });

  it("treats an ABSENT/EXEMPT null mark as 0 toward the earned total, not an exclusion", async () => {
    vi.mocked(prisma.assessment.findMany).mockResolvedValue([
      {
        id: "assessment-1",
        title: "Quiz 1",
        status: "PUBLISHED",
        maximumMarks: 20,
        assessmentType: { name: "Quiz" },
        results: [{ enrollmentId: "enr-1", mark: null }],
      },
    ] as never);

    const report = await getCourseReport("assign-1");

    const alice = report?.studentTotals.find((s) => s.enrollmentId === "enr-1");
    expect(alice).toMatchObject({ earned: 0, possible: 20, percentage: 0 });
  });
});
