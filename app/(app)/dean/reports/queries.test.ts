import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    lecturerCourseAssignment: { findFirst: vi.fn(), findMany: vi.fn() },
    studentCourseEnrollment: { findMany: vi.fn() },
    assessment: { findMany: vi.fn() },
    class: { findFirst: vi.fn() },
    semester: { findUnique: vi.fn() },
    student: { findFirst: vi.fn() },
    assessmentResult: { findMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import { getCourseReport, getClassReport, getStudentReport } from "./queries";

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

const CS = ["dept-cs"];

describe("getCourseReport", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue(
      assignment as never
    );
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue(
      enrollments as never
    );
  });

  it("returns null when the assignment doesn't exist", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue(null);

    expect(await getCourseReport("missing", CS)).toBeNull();
    expect(prisma.assessment.findMany).not.toHaveBeenCalled();
  });

  it("scopes the assignment lookup to the dean's overseen departments", async () => {
    vi.mocked(prisma.assessment.findMany).mockResolvedValue([]);

    await getCourseReport("assign-1", CS);

    expect(prisma.lecturerCourseAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "assign-1",
          class: { program: { departmentId: { in: CS } } },
        },
      })
    );
  });

  it("returns null for an assignment outside the dean's departments — not a bug, the scope IS the query", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue(null);

    expect(await getCourseReport("faculty-b-assignment", CS)).toBeNull();
  });

  it("an unassigned dean (empty departmentIds) can never find any assignment", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue(null);

    expect(await getCourseReport("assign-1", [])).toBeNull();
    expect(prisma.lecturerCourseAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          class: { program: { departmentId: { in: [] } } },
        }),
      })
    );
  });

  it("only ever selects PUBLISHED results — the query itself is the draft guard", async () => {
    vi.mocked(prisma.assessment.findMany).mockResolvedValue([]);

    await getCourseReport("assign-1", CS);

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

    const report = await getCourseReport("assign-1", CS);

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

    const report = await getCourseReport("assign-1", CS);

    const alice = report?.studentTotals.find((s) => s.enrollmentId === "enr-1");
    expect(alice).toMatchObject({ earned: 0, possible: 20, percentage: 0 });
  });
});

describe("getClassReport", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.class.findFirst).mockResolvedValue({
      id: "class-1",
      name: "CMS2518-A-FT",
    } as never);
    vi.mocked(prisma.semester.findUnique).mockResolvedValue({
      id: "sem-1",
      name: "Semester 1",
      academicYear: { name: "2025-2026" },
    } as never);
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([]);
  });

  it("scopes the class lookup to the dean's overseen departments", async () => {
    await getClassReport("class-1", "sem-1", CS);

    expect(prisma.class.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "class-1",
          program: { departmentId: { in: CS } },
        },
      })
    );
  });

  it("returns null for a class outside the dean's departments", async () => {
    vi.mocked(prisma.class.findFirst).mockResolvedValue(null);

    expect(await getClassReport("faculty-b-class", "sem-1", CS)).toBeNull();
    expect(prisma.lecturerCourseAssignment.findMany).not.toHaveBeenCalled();
  });

  it("a dean linked to two departments can see either", async () => {
    const bothDepts = ["dept-cs", "dept-eng"];

    await getClassReport("class-1", "sem-1", bothDepts);

    expect(prisma.class.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          program: { departmentId: { in: bothDepts } },
        }),
      })
    );
  });

  it("an unassigned dean (empty departmentIds) can never find any class", async () => {
    vi.mocked(prisma.class.findFirst).mockResolvedValue(null);

    expect(await getClassReport("class-1", "sem-1", [])).toBeNull();
  });
});

describe("getStudentReport", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.student.findFirst).mockResolvedValue({
      id: "student-1",
      studentNo: "S1",
      fullName: "Alice",
      class: { name: "CMS2518-A-FT" },
    } as never);
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([]);
  });

  it("scopes the student lookup to the dean's overseen departments", async () => {
    await getStudentReport("student-1", CS);

    expect(prisma.student.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "student-1",
          class: { program: { departmentId: { in: CS } } },
        },
      })
    );
  });

  it("also scopes the enrollment history query, not just the student lookup", async () => {
    await getStudentReport("student-1", CS);

    expect(prisma.studentCourseEnrollment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          studentId: "student-1",
          class: { program: { departmentId: { in: CS } } },
        },
      })
    );
  });

  it("returns null for a student outside the dean's departments", async () => {
    vi.mocked(prisma.student.findFirst).mockResolvedValue(null);

    expect(await getStudentReport("faculty-b-student", CS)).toBeNull();
    expect(prisma.studentCourseEnrollment.findMany).not.toHaveBeenCalled();
  });

  it("an unassigned dean (empty departmentIds) can never find any student", async () => {
    vi.mocked(prisma.student.findFirst).mockResolvedValue(null);

    expect(await getStudentReport("student-1", [])).toBeNull();
  });
});
