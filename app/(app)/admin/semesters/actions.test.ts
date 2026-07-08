import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAdmin = { id: "admin-1" };

vi.mock("@/lib/auth", () => ({
  requireRole: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("@/lib/enrollment", () => ({
  autoEnrollClassIntoAssignment: vi.fn(),
  auditAutoEnrollments: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

function makeTx() {
  return {
    semester: { updateMany: vi.fn(), update: vi.fn() },
    class: { update: vi.fn() },
    lecturerCourseAssignment: { create: vi.fn() },
  };
}

let tx = makeTx();

vi.mock("@/lib/db", () => ({
  prisma: {
    semester: { findUniqueOrThrow: vi.fn() },
    class: { findMany: vi.fn() },
    classCoursePlan: { findMany: vi.fn() },
    lecturerCourseAssignment: { findMany: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
  },
}));

import { requireRole } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  autoEnrollClassIntoAssignment,
  auditAutoEnrollments,
} from "@/lib/enrollment";
import { prisma } from "@/lib/db";
import { openSemester } from "./actions";

describe("openSemester", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx = makeTx();
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) =>
      (fn as (tx: unknown) => unknown)(tx)
    );
    vi.mocked(requireRole).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.semester.findUniqueOrThrow).mockResolvedValue({
      id: "sem-1",
      isClosed: false,
    } as never);
    vi.mocked(prisma.class.findMany).mockResolvedValue([
      { id: "class-1", name: "CMS2518-A-FT", currentSemesterNumber: 2 },
    ] as never);
    vi.mocked(prisma.classCoursePlan.findMany).mockResolvedValue([]);
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([]);
    vi.mocked(autoEnrollClassIntoAssignment).mockResolvedValue([]);
  });

  it("refuses to open a closed semester", async () => {
    vi.mocked(prisma.semester.findUniqueOrThrow).mockResolvedValue({
      id: "sem-1",
      isClosed: true,
    } as never);

    await expect(
      openSemester({ semesterId: "sem-1", classes: [] })
    ).rejects.toThrow("CLOSED_SEMESTER");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("deactivates every other active semester globally, not just within the same academic year", async () => {
    await openSemester({ semesterId: "sem-1", classes: [] });

    expect(tx.semester.updateMany).toHaveBeenCalledWith({
      where: { isActive: true, NOT: { id: "sem-1" } },
      data: { isActive: false },
    });
    expect(tx.semester.update).toHaveBeenCalledWith({
      where: { id: "sem-1" },
      data: { isActive: true },
    });
  });

  it("refuses a class that hasn't been set up with a semester number", async () => {
    vi.mocked(prisma.class.findMany).mockResolvedValue([
      { id: "class-1", currentSemesterNumber: null },
    ] as never);

    await expect(
      openSemester({
        semesterId: "sem-1",
        classes: [{ classId: "class-1", advance: false, lecturerByCourse: {} }],
      })
    ).rejects.toThrow("CLASS_NOT_SET_UP");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses to advance a class past semester 8", async () => {
    vi.mocked(prisma.class.findMany).mockResolvedValue([
      { id: "class-1", currentSemesterNumber: 8 },
    ] as never);

    await expect(
      openSemester({
        semesterId: "sem-1",
        classes: [{ classId: "class-1", advance: true, lecturerByCourse: {} }],
      })
    ).rejects.toThrow("MAX_SEMESTER_REACHED");
  });

  it("requires a lecturer for every planned course at the resolved semester level", async () => {
    vi.mocked(prisma.classCoursePlan.findMany).mockResolvedValue([
      { id: "plan-1", classId: "class-1", courseId: "course-1", semesterNumber: 2 },
    ] as never);

    await expect(
      openSemester({
        semesterId: "sem-1",
        classes: [{ classId: "class-1", advance: false, lecturerByCourse: {} }],
      })
    ).rejects.toThrow("MISSING_LECTURER");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("advances currentSemesterNumber only for classes marked to advance", async () => {
    vi.mocked(tx.lecturerCourseAssignment.create).mockResolvedValue({
      id: "assign-1",
      courseId: "course-1",
      classId: "class-1",
      semesterId: "sem-1",
    } as never);
    vi.mocked(prisma.classCoursePlan.findMany).mockResolvedValue([
      { id: "plan-1", classId: "class-1", courseId: "course-1", semesterNumber: 3 },
    ] as never);

    await openSemester({
      semesterId: "sem-1",
      classes: [
        {
          classId: "class-1",
          advance: true,
          lecturerByCourse: { "course-1": "lect-1" },
        },
      ],
    });

    expect(tx.class.update).toHaveBeenCalledWith({
      where: { id: "class-1" },
      data: { currentSemesterNumber: 3 },
    });
    expect(tx.lecturerCourseAssignment.create).toHaveBeenCalledWith({
      data: {
        lecturerId: "lect-1",
        courseId: "course-1",
        classId: "class-1",
        semesterId: "sem-1",
      },
    });
    expect(autoEnrollClassIntoAssignment).toHaveBeenCalledWith(tx, {
      id: "assign-1",
      courseId: "course-1",
      classId: "class-1",
      semesterId: "sem-1",
    });
  });

  it("does not advance a class left unchecked, but still assigns its current level's courses", async () => {
    vi.mocked(prisma.classCoursePlan.findMany).mockResolvedValue([
      { id: "plan-1", classId: "class-1", courseId: "course-1", semesterNumber: 2 },
    ] as never);

    await openSemester({
      semesterId: "sem-1",
      classes: [
        {
          classId: "class-1",
          advance: false,
          lecturerByCourse: { "course-1": "lect-1" },
        },
      ],
    });

    expect(tx.class.update).not.toHaveBeenCalled();
    expect(tx.lecturerCourseAssignment.create).toHaveBeenCalledWith({
      data: {
        lecturerId: "lect-1",
        courseId: "course-1",
        classId: "class-1",
        semesterId: "sem-1",
      },
    });
  });

  it("pre-checks for assignments that already exist and only creates the rest — never attempting (and failing on) a duplicate create", async () => {
    // Catching a unique-constraint violation mid-transaction does NOT let
    // Postgres continue to the next statement — the whole transaction
    // aborts from that point on. So existing assignments must be filtered
    // out via a query before the transaction even starts.
    vi.mocked(prisma.classCoursePlan.findMany).mockResolvedValue([
      { id: "plan-1", classId: "class-1", courseId: "course-1", semesterNumber: 2 },
      { id: "plan-2", classId: "class-1", courseId: "course-2", semesterNumber: 2 },
    ] as never);
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      {
        lecturerId: "lect-1",
        courseId: "course-1",
        classId: "class-1",
        lecturer: { user: { fullName: "Dr. Existing" } },
      },
    ] as never);
    vi.mocked(tx.lecturerCourseAssignment.create).mockResolvedValue({
      id: "assign-2",
      courseId: "course-2",
      classId: "class-1",
      semesterId: "sem-1",
    } as never);

    await openSemester({
      semesterId: "sem-1",
      classes: [
        {
          classId: "class-1",
          advance: false,
          lecturerByCourse: { "course-1": "lect-1", "course-2": "lect-1" },
        },
      ],
    });

    expect(tx.lecturerCourseAssignment.create).toHaveBeenCalledTimes(1);
    expect(tx.lecturerCourseAssignment.create).toHaveBeenCalledWith({
      data: {
        lecturerId: "lect-1",
        courseId: "course-2",
        classId: "class-1",
        semesterId: "sem-1",
      },
    });
    expect(autoEnrollClassIntoAssignment).toHaveBeenCalledTimes(1);
  });

  it("blocks opening when a course+class is already assigned to a DIFFERENT lecturer, naming them instead of failing inside the transaction", async () => {
    vi.mocked(prisma.classCoursePlan.findMany).mockResolvedValue([
      {
        id: "plan-1",
        classId: "class-1",
        courseId: "course-1",
        semesterNumber: 2,
        course: { name: "Data Structures" },
      },
    ] as never);
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      {
        lecturerId: "lect-1",
        courseId: "course-1",
        classId: "class-1",
        lecturer: { user: { fullName: "Dr. Existing" } },
      },
    ] as never);

    await expect(
      openSemester({
        semesterId: "sem-1",
        classes: [
          {
            classId: "class-1",
            advance: false,
            lecturerByCourse: { "course-1": "lect-2" },
          },
        ],
      })
    ).rejects.toThrow(/Dr\. Existing/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("audits SEMESTER_OPENED with counts and the auto-enrollments after the transaction commits", async () => {
    await openSemester({ semesterId: "sem-1", classes: [] });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "SEMESTER_OPENED",
        entity: "Semester",
        entityId: "sem-1",
        newValue: { classesAdvanced: 0, assignmentsCreated: 0 },
      })
    );
    expect(auditAutoEnrollments).toHaveBeenCalledWith("admin-1", []);
  });

  it("enforces admin-only access before touching anything", async () => {
    vi.mocked(requireRole).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(
      openSemester({ semesterId: "sem-1", classes: [] })
    ).rejects.toThrow("FORBIDDEN");
    expect(prisma.semester.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});
