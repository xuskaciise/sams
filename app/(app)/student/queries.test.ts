import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    student: { findUnique: vi.fn() },
    semester: { findFirst: vi.fn() },
    studentCourseEnrollment: { findMany: vi.fn(), findFirst: vi.fn() },
    assessmentResult: { findMany: vi.fn() },
    lecturerCourseAssignment: { findFirst: vi.fn() },
    assessment: { findMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import { getStudentDashboardData, getStudentCourseDetail } from "./queries";

describe("getStudentDashboardData", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when the session user has no student profile", async () => {
    vi.mocked(prisma.student.findUnique).mockResolvedValue(null);

    const result = await getStudentDashboardData("user-1");

    expect(result).toBeNull();
    expect(prisma.semester.findFirst).not.toHaveBeenCalled();
  });

  it("scopes the student lookup to the session's userId", async () => {
    vi.mocked(prisma.student.findUnique).mockResolvedValue({
      id: "student-1",
      class: {},
    } as never);
    vi.mocked(prisma.semester.findFirst).mockResolvedValue(null);

    await getStudentDashboardData("user-1");

    expect(prisma.student.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } })
    );
  });

  it("returns no courses and never queries enrollments when there is no active semester", async () => {
    vi.mocked(prisma.student.findUnique).mockResolvedValue({
      id: "student-1",
      class: {},
    } as never);
    vi.mocked(prisma.semester.findFirst).mockResolvedValue(null);

    const result = await getStudentDashboardData("user-1");

    expect(result?.courses).toEqual([]);
    expect(prisma.studentCourseEnrollment.findMany).not.toHaveBeenCalled();
  });

  it("only ever fetches PUBLISHED results for the totals — never drafts", async () => {
    vi.mocked(prisma.student.findUnique).mockResolvedValue({
      id: "student-1",
      class: {},
    } as never);
    vi.mocked(prisma.semester.findFirst).mockResolvedValue({
      id: "sem-1",
      academicYear: {},
    } as never);
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([
      { id: "enr-1", course: { name: "Databases" } },
    ] as never);
    vi.mocked(prisma.assessmentResult.findMany).mockResolvedValue([
      { enrollmentId: "enr-1", mark: 18, assessment: { maximumMarks: 20 } },
    ] as never);

    const result = await getStudentDashboardData("user-1");

    expect(prisma.assessmentResult.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "PUBLISHED" }),
      })
    );
    expect(result?.courses).toEqual([
      {
        enrollment: { id: "enr-1", course: { name: "Databases" } },
        earned: 18,
        possible: 20,
        gradedCount: 1,
      },
    ]);
  });
});

describe("getStudentCourseDetail", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("scopes the enrollment lookup to the session's userId — a mismatched enrollment id returns null", async () => {
    // This IS the defense against URL manipulation: the where clause itself
    // ties the lookup to the session's user, so student B's enrollment id
    // simply never matches when student A is logged in.
    vi.mocked(prisma.studentCourseEnrollment.findFirst).mockResolvedValue(
      null
    );

    const result = await getStudentCourseDetail("user-a", "enrollment-of-student-b");

    expect(prisma.studentCourseEnrollment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "enrollment-of-student-b",
          student: { userId: "user-a" },
        },
      })
    );
    expect(result).toBeNull();
    expect(prisma.assessment.findMany).not.toHaveBeenCalled();
  });

  it("only ever selects PUBLISHED results for THIS enrollment when fetching assessments", async () => {
    vi.mocked(prisma.studentCourseEnrollment.findFirst).mockResolvedValue({
      id: "enr-1",
      courseId: "course-1",
      classId: "class-1",
      semesterId: "sem-1",
      course: {},
      class: {},
      semester: {},
    } as never);
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue({
      id: "assign-1",
    } as never);
    vi.mocked(prisma.assessment.findMany).mockResolvedValue([]);

    await getStudentCourseDetail("user-1", "enr-1");

    expect(prisma.assessment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { assignmentId: "assign-1", deletedAt: null },
        include: expect.objectContaining({
          results: {
            where: { enrollmentId: "enr-1", status: "PUBLISHED" },
          },
        }),
      })
    );
  });

  it("returns an empty assessment list (not an error) when no assignment exists for that course+class+semester", async () => {
    vi.mocked(prisma.studentCourseEnrollment.findFirst).mockResolvedValue({
      id: "enr-1",
      courseId: "course-1",
      classId: "class-1",
      semesterId: "sem-1",
      course: {},
      class: {},
      semester: {},
    } as never);
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue(null);

    const result = await getStudentCourseDetail("user-1", "enr-1");

    expect(result?.assessments).toEqual([]);
    expect(prisma.assessment.findMany).not.toHaveBeenCalled();
  });
});
