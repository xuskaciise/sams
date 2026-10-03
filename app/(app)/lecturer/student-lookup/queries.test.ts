import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    lecturerCourseAssignment: { findMany: vi.fn() },
    student: { findFirst: vi.fn() },
    studentCourseEnrollment: { findMany: vi.fn() },
    assessmentResult: { findMany: vi.fn() },
    groupMember: { findMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import { getStudentResultsForLecturer } from "./queries";

const semester = { name: "Semester 1", academicYear: { name: "2026-2027" } };

function assessment(id: string, status: string, mode = "INDIVIDUAL") {
  return {
    id,
    title: `Quiz ${id}`,
    status,
    mode,
    maximumMarks: 10,
    assessmentType: { name: "Quiz" },
  };
}

const myAssignment = {
  id: "assign-1",
  courseId: "course-1",
  classId: "class-1",
  semesterId: "sem-1",
  course: { name: "Databases" },
  class: { name: "CMS26-A-FT", currentSemesterNumber: 3 },
  semester,
  assessments: [
    assessment("a-draft", "DRAFT"),
    assessment("a-pub", "PUBLISHED"),
    assessment("a-closed", "CLOSED"),
  ],
};

const student = { id: "student-1", studentNo: "S1", fullName: "Alice" };
const enrollment = {
  id: "enr-1",
  studentId: "student-1",
  courseId: "course-1",
  classId: "class-1",
  semesterId: "sem-1",
  status: "ACTIVE",
};

describe("getStudentResultsForLecturer", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([myAssignment] as never);
    vi.mocked(prisma.student.findFirst).mockResolvedValue(student as never);
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([enrollment] as never);
    vi.mocked(prisma.assessmentResult.findMany).mockResolvedValue([]);
    vi.mocked(prisma.groupMember.findMany).mockResolvedValue([]);
  });

  it("scopes assignments to the caller's own lecturer profile", async () => {
    await getStudentResultsForLecturer("user-1", "S1");
    expect(prisma.lecturerCourseAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lecturer: { userId: "user-1" } } })
    );
  });

  it("only matches enrollments on the lecturer's own course/class/semester tuples", async () => {
    await getStudentResultsForLecturer("user-1", "s1");
    expect(prisma.student.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { studentNo: { equals: "s1", mode: "insensitive" } },
      })
    );
    expect(prisma.studentCourseEnrollment.findMany).toHaveBeenCalledWith({
      where: {
        studentId: "student-1",
        status: { not: "DROPPED" },
        OR: [{ courseId: "course-1", classId: "class-1", semesterId: "sem-1" }],
      },
    });
  });

  it("returns null when the student isn't enrolled in any of the lecturer's courses", async () => {
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([]);
    expect(await getStudentResultsForLecturer("user-1", "S1")).toBeNull();
  });

  it("returns null (same as not-enrolled) for an unknown student", async () => {
    vi.mocked(prisma.student.findFirst).mockResolvedValue(null);
    expect(await getStudentResultsForLecturer("user-1", "NOPE")).toBeNull();
    expect(prisma.studentCourseEnrollment.findMany).not.toHaveBeenCalled();
  });

  it("returns null without querying students when the lecturer has no assignments", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([]);
    expect(await getStudentResultsForLecturer("user-1", "S1")).toBeNull();
    expect(prisma.student.findFirst).not.toHaveBeenCalled();
  });

  it("builds one row per assessment with the right action per status", async () => {
    vi.mocked(prisma.assessmentResult.findMany).mockResolvedValue([
      {
        id: "r-pub",
        assessmentId: "a-pub",
        enrollmentId: "enr-1",
        status: "PUBLISHED",
        mark: 7,
        attendanceStatus: "PRESENT",
        updatedAt: new Date("2026-10-01T00:00:00Z"),
        isCorrected: false,
        groupId: null,
      },
    ] as never);

    const result = await getStudentResultsForLecturer("user-1", "S1");
    expect(result?.student).toEqual(student);
    const byId = Object.fromEntries(result!.rows.map((r) => [r.assessmentId, r]));
    expect(byId["a-draft"].action).toEqual({ kind: "ENTER" });
    expect(byId["a-pub"].action).toEqual({ kind: "CORRECT" });
    expect(byId["a-pub"]).toMatchObject({
      resultId: "r-pub",
      resultStatus: "PUBLISHED",
      mark: 7,
      updatedAt: "2026-10-01T00:00:00.000Z",
      classLabel: "CMS26-A-FT (Semester 3)",
    });
    expect(byId["a-closed"].action.kind).toBe("READ_ONLY");
  });

  it("carries the student's group for a GROUP-mode assessment with no result yet", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      { ...myAssignment, assessments: [assessment("a-grp", "DRAFT", "GROUP")] },
    ] as never);
    vi.mocked(prisma.groupMember.findMany).mockResolvedValue([
      { assignmentId: "assign-1", groupId: "group-9" },
    ] as never);
    const result = await getStudentResultsForLecturer("user-1", "S1");
    expect(result!.rows[0].groupId).toBe("group-9");
  });
});
