import { describe, it, expect, vi, beforeEach } from "vitest";

const mockUser = { id: "user-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
  getUserAccess: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    student: { findFirst: vi.fn() },
    lecturerCourseAssignment: { findFirst: vi.fn(), findMany: vi.fn() },
    studentCourseEnrollment: { findFirst: vi.fn(), findMany: vi.fn() },
    missedExamRecord: { create: vi.fn() },
  },
}));

vi.mock("@/lib/dean-scope", () => ({
  getDeanDepartmentIds: vi.fn(),
  classDeanWhere: vi.fn((ids: string[]) => ({
    program: { departmentId: { in: ids } },
  })),
  assignmentDeanWhere: vi.fn((ids: string[]) => ({
    class: { program: { departmentId: { in: ids } } },
  })),
  studentDeanWhere: vi.fn((ids: string[]) => ({
    class: { program: { departmentId: { in: ids } } },
  })),
  missedExamRecordDeanWhere: vi.fn((ids: string[]) => ({
    assignment: { class: { program: { departmentId: { in: ids } } } },
  })),
}));

import { requirePermission, getUserAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import { recordMissedExam, getStudentExamOptionsAction } from "./actions";

const student = { id: "student-1", studentNo: "S1001", fullName: "Jane Doe" };
const assignment = {
  id: "assign-1",
  courseId: "course-1",
  classId: "class-1",
  semesterId: "sem-1",
  course: { id: "course-1", name: "Databases" },
};
const enrollment = {
  id: "enr-1",
  studentId: "student-1",
  courseId: "course-1",
  classId: "class-1",
  semesterId: "sem-1",
  status: "ACTIVE",
};

function mockRoles(roleNames: string[]) {
  vi.mocked(getUserAccess).mockResolvedValue({
    permissions: new Set(),
    roleNames,
  } as never);
}

const validInput = {
  studentId: "student-1",
  assignmentId: "assign-1",
  examType: "MIDTERM" as const,
  reasonType: "ILLNESS" as const,
  reasonNote: "Hospitalized",
};

describe("recordMissedExam", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.student.findFirst).mockResolvedValue(student as never);
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue(
      assignment as never
    );
    vi.mocked(prisma.studentCourseEnrollment.findFirst).mockResolvedValue(
      enrollment as never
    );
    vi.mocked(prisma.missedExamRecord.create).mockResolvedValue({
      id: "record-1",
      examType: "MIDTERM",
      reasonType: "ILLNESS",
    } as never);
  });

  it("enforces exam.records.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(recordMissedExam(validInput)).rejects.toThrow("FORBIDDEN");
    expect(prisma.student.findFirst).not.toHaveBeenCalled();
  });

  it("ADMIN can record for any student/assignment — no dean scope applied", async () => {
    mockRoles(["ADMIN"]);

    await recordMissedExam(validInput);

    expect(prisma.student.findFirst).toHaveBeenCalledWith({
      where: { id: "student-1" },
    });
    expect(prisma.lecturerCourseAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "assign-1" } })
    );
    expect(getDeanDepartmentIds).not.toHaveBeenCalled();
  });

  it("DEAN is scoped: student lookup includes their dean_departments where-clause", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-1"]);

    await recordMissedExam(validInput);

    expect(prisma.student.findFirst).toHaveBeenCalledWith({
      where: {
        id: "student-1",
        class: { program: { departmentId: { in: ["dept-1"] } } },
      },
    });
    expect(prisma.lecturerCourseAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "assign-1",
          class: { program: { departmentId: { in: ["dept-1"] } } },
        },
      })
    );
  });

  it("throws STUDENT_NOT_FOUND when the student doesn't resolve (out of a Dean's scope)", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-1"]);
    vi.mocked(prisma.student.findFirst).mockResolvedValue(null);

    await expect(recordMissedExam(validInput)).rejects.toThrow("STUDENT_NOT_FOUND");
    expect(prisma.missedExamRecord.create).not.toHaveBeenCalled();
  });

  it("throws ASSIGNMENT_NOT_FOUND when the assignment doesn't resolve (out of a Dean's scope)", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-1"]);
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue(null);

    await expect(recordMissedExam(validInput)).rejects.toThrow("ASSIGNMENT_NOT_FOUND");
    expect(prisma.missedExamRecord.create).not.toHaveBeenCalled();
  });

  it("throws NOT_ENROLLED when the student has no matching ACTIVE enrollment for that assignment's course+class+semester", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.studentCourseEnrollment.findFirst).mockResolvedValue(null);

    await expect(recordMissedExam(validInput)).rejects.toThrow("NOT_ENROLLED");
    expect(prisma.missedExamRecord.create).not.toHaveBeenCalled();
  });

  it("creates the record with courseId/semesterId denormalized from the assignment, and audits it", async () => {
    mockRoles(["ADMIN"]);

    await recordMissedExam(validInput);

    expect(prisma.missedExamRecord.create).toHaveBeenCalledWith({
      data: {
        studentId: "student-1",
        courseId: "course-1",
        assignmentId: "assign-1",
        semesterId: "sem-1",
        examType: "MIDTERM",
        reasonType: "ILLNESS",
        reasonNote: "Hospitalized",
        recordedById: "user-1",
      },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        action: "MISSED_EXAM_RECORDED",
        entity: "MissedExamRecord",
        entityId: "record-1",
        newValue: expect.objectContaining({
          studentId: "student-1",
          studentNo: "S1001",
          examType: "MIDTERM",
          reasonType: "ILLNESS",
        }),
      })
    );
  });

  it("stores a null reasonNote when omitted", async () => {
    mockRoles(["ADMIN"]);

    await recordMissedExam({ ...validInput, reasonNote: undefined });

    expect(prisma.missedExamRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reasonNote: null }) })
    );
  });
});

describe("getStudentExamOptionsAction", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
  });

  it("enforces exam.records.manage", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(getStudentExamOptionsAction("student-1")).rejects.toThrow("FORBIDDEN");
  });

  it("returns [] without querying when studentId is empty", async () => {
    mockRoles(["ADMIN"]);
    const result = await getStudentExamOptionsAction("");
    expect(result).toEqual([]);
    expect(prisma.student.findFirst).not.toHaveBeenCalled();
  });

  it("a DEAN gets [] for a student outside their own scope, without leaking enrollment data", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-1"]);
    vi.mocked(prisma.student.findFirst).mockResolvedValue(null);

    const result = await getStudentExamOptionsAction("student-1");

    expect(result).toEqual([]);
    expect(prisma.studentCourseEnrollment.findMany).not.toHaveBeenCalled();
  });

  it("resolves options via the student's ACTIVE enrollments matched to real assignments", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([
      {
        courseId: "course-1",
        classId: "class-1",
        semesterId: "sem-1",
        course: { id: "course-1", name: "Databases", code: "CS201" },
        class: { name: "CMS-A" },
        semester: { id: "sem-1", name: "Semester 1" },
      },
    ] as never);
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      { id: "assign-1", courseId: "course-1", classId: "class-1", semesterId: "sem-1" },
    ] as never);

    const result = await getStudentExamOptionsAction("student-1");

    expect(result).toEqual([
      {
        assignmentId: "assign-1",
        courseId: "course-1",
        courseName: "Databases",
        courseCode: "CS201",
        className: "CMS-A",
        semesterId: "sem-1",
        semesterName: "Semester 1",
      },
    ]);
  });

  it("skips an enrollment with no matching assignment rather than throwing", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([
      {
        courseId: "course-1",
        classId: "class-1",
        semesterId: "sem-1",
        course: { id: "course-1", name: "Databases", code: "CS201" },
        class: { name: "CMS-A" },
        semester: { id: "sem-1", name: "Semester 1" },
      },
    ] as never);
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([]);

    const result = await getStudentExamOptionsAction("student-1");

    expect(result).toEqual([]);
  });
});
