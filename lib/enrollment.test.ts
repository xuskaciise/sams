import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

import { audit } from "@/lib/audit";
import {
  autoEnrollStudentIntoClassCourses,
  autoEnrollClassIntoAssignment,
  auditAutoEnrollments,
} from "./enrollment";

function duplicateError() {
  return new Prisma.PrismaClientKnownRequestError("duplicate", {
    code: "P2002",
    clientVersion: "test",
  });
}

function fakeTx(overrides: Record<string, unknown> = {}) {
  return {
    lecturerCourseAssignment: { findMany: vi.fn() },
    student: { findMany: vi.fn() },
    studentCourseEnrollment: { create: vi.fn() },
    ...overrides,
  } as unknown as Prisma.TransactionClient;
}

describe("autoEnrollStudentIntoClassCourses", () => {
  it("only considers assignments whose semester is currently active", async () => {
    const tx = fakeTx();
    vi.mocked(tx.lecturerCourseAssignment.findMany).mockResolvedValue([]);

    await autoEnrollStudentIntoClassCourses(tx, "student-1", "class-1");

    expect(tx.lecturerCourseAssignment.findMany).toHaveBeenCalledWith({
      where: { classId: "class-1", semester: { isActive: true } },
    });
  });

  it("enrolls the student in every course assigned to the class", async () => {
    const tx = fakeTx();
    vi.mocked(tx.lecturerCourseAssignment.findMany).mockResolvedValue([
      { courseId: "course-1", semesterId: "sem-1" },
      { courseId: "course-2", semesterId: "sem-1" },
    ] as never);
    vi.mocked(tx.studentCourseEnrollment.create)
      .mockResolvedValueOnce({ id: "enr-1" } as never)
      .mockResolvedValueOnce({ id: "enr-2" } as never);

    const result = await autoEnrollStudentIntoClassCourses(
      tx,
      "student-1",
      "class-1"
    );

    expect(tx.studentCourseEnrollment.create).toHaveBeenCalledTimes(2);
    expect(result).toEqual([
      {
        enrollmentId: "enr-1",
        studentId: "student-1",
        courseId: "course-1",
        semesterId: "sem-1",
      },
      {
        enrollmentId: "enr-2",
        studentId: "student-1",
        courseId: "course-2",
        semesterId: "sem-1",
      },
    ]);
  });

  it("silently skips a course the student is already enrolled in", async () => {
    const tx = fakeTx();
    vi.mocked(tx.lecturerCourseAssignment.findMany).mockResolvedValue([
      { courseId: "course-1", semesterId: "sem-1" },
    ] as never);
    vi.mocked(tx.studentCourseEnrollment.create).mockRejectedValue(
      duplicateError()
    );

    const result = await autoEnrollStudentIntoClassCourses(
      tx,
      "student-1",
      "class-1"
    );

    expect(result).toEqual([]);
  });

  it("propagates non-duplicate errors instead of swallowing them", async () => {
    const tx = fakeTx();
    vi.mocked(tx.lecturerCourseAssignment.findMany).mockResolvedValue([
      { courseId: "course-1", semesterId: "sem-1" },
    ] as never);
    vi.mocked(tx.studentCourseEnrollment.create).mockRejectedValue(
      new Error("connection lost")
    );

    await expect(
      autoEnrollStudentIntoClassCourses(tx, "student-1", "class-1")
    ).rejects.toThrow("connection lost");
  });
});

describe("autoEnrollClassIntoAssignment", () => {
  it("enrolls every current student of the class into the new assignment's course", async () => {
    const tx = fakeTx();
    vi.mocked(tx.student.findMany).mockResolvedValue([
      { id: "student-1" },
      { id: "student-2" },
    ] as never);
    vi.mocked(tx.studentCourseEnrollment.create)
      .mockResolvedValueOnce({ id: "enr-1" } as never)
      .mockResolvedValueOnce({ id: "enr-2" } as never);

    const result = await autoEnrollClassIntoAssignment(tx, {
      courseId: "course-1",
      classId: "class-1",
      semesterId: "sem-1",
    });

    expect(tx.student.findMany).toHaveBeenCalledWith({
      where: { classId: "class-1" },
    });
    expect(result).toHaveLength(2);
  });

  it("skips students already enrolled in that course for that semester", async () => {
    const tx = fakeTx();
    vi.mocked(tx.student.findMany).mockResolvedValue([
      { id: "student-1" },
    ] as never);
    vi.mocked(tx.studentCourseEnrollment.create).mockRejectedValue(
      duplicateError()
    );

    const result = await autoEnrollClassIntoAssignment(tx, {
      courseId: "course-1",
      classId: "class-1",
      semesterId: "sem-1",
    });

    expect(result).toEqual([]);
  });
});

describe("auditAutoEnrollments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes one AUTO_ENROLLED audit entry per record, after any transaction has already committed", async () => {
    await auditAutoEnrollments("admin-1", [
      {
        enrollmentId: "enr-1",
        studentId: "student-1",
        courseId: "course-1",
        semesterId: "sem-1",
      },
    ]);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "AUTO_ENROLLED",
        entity: "StudentCourseEnrollment",
        entityId: "enr-1",
      })
    );
  });

  it("does nothing for an empty list", async () => {
    await auditAutoEnrollments("admin-1", []);
    expect(audit).not.toHaveBeenCalled();
  });
});
