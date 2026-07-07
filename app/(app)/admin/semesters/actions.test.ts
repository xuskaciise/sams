import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

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

function duplicateError() {
  return new Prisma.PrismaClientKnownRequestError("duplicate", {
    code: "P2002",
    clientVersion: "test",
  });
}

function makeTx() {
  return {
    semester: { updateMany: vi.fn(), update: vi.fn() },
    lecturerCourseAssignment: { create: vi.fn() },
  };
}

let tx = makeTx();

vi.mock("@/lib/db", () => ({
  prisma: {
    semester: { findUniqueOrThrow: vi.fn() },
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
    vi.mocked(autoEnrollClassIntoAssignment).mockResolvedValue([]);
  });

  it("refuses to open a closed semester", async () => {
    vi.mocked(prisma.semester.findUniqueOrThrow).mockResolvedValue({
      id: "sem-1",
      isClosed: true,
    } as never);

    await expect(
      openSemester({ semesterId: "sem-1", selections: [] })
    ).rejects.toThrow("CLOSED_SEMESTER");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("deactivates every other active semester globally, not just within the same academic year", async () => {
    await openSemester({ semesterId: "sem-1", selections: [] });

    expect(tx.semester.updateMany).toHaveBeenCalledWith({
      where: { isActive: true, NOT: { id: "sem-1" } },
      data: { isActive: false },
    });
    expect(tx.semester.update).toHaveBeenCalledWith({
      where: { id: "sem-1" },
      data: { isActive: true },
    });
  });

  it("creates one assignment per selected course and auto-enrolls that class", async () => {
    vi.mocked(tx.lecturerCourseAssignment.create).mockResolvedValue({
      id: "assign-1",
      courseId: "course-1",
      classId: "class-1",
      semesterId: "sem-1",
    } as never);

    await openSemester({
      semesterId: "sem-1",
      selections: [
        {
          classId: "class-1",
          courses: [{ courseId: "course-1", lecturerId: "lect-1" }],
        },
      ],
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

  it("skips a course whose exact assignment already exists instead of failing the whole operation", async () => {
    vi.mocked(tx.lecturerCourseAssignment.create)
      .mockRejectedValueOnce(duplicateError())
      .mockResolvedValueOnce({
        id: "assign-2",
        courseId: "course-2",
        classId: "class-1",
        semesterId: "sem-1",
      } as never);

    await openSemester({
      semesterId: "sem-1",
      selections: [
        {
          classId: "class-1",
          courses: [
            { courseId: "course-1", lecturerId: "lect-1" },
            { courseId: "course-2", lecturerId: "lect-1" },
          ],
        },
      ],
    });

    expect(autoEnrollClassIntoAssignment).toHaveBeenCalledTimes(1);
  });

  it("audits SEMESTER_OPENED and the auto-enrollments after the transaction commits", async () => {
    await openSemester({ semesterId: "sem-1", selections: [] });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "SEMESTER_OPENED",
        entity: "Semester",
        entityId: "sem-1",
      })
    );
    expect(auditAutoEnrollments).toHaveBeenCalledWith("admin-1", []);
  });

  it("enforces admin-only access before touching anything", async () => {
    vi.mocked(requireRole).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(
      openSemester({ semesterId: "sem-1", selections: [] })
    ).rejects.toThrow("FORBIDDEN");
    expect(prisma.semester.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});
