import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const mockAdmin = { id: "admin-1" };

vi.mock("@/lib/auth", () => ({
  requireRole: vi.fn(),
}));

vi.mock("@/lib/enrollment", () => ({
  autoEnrollClassIntoAssignment: vi.fn(),
  auditAutoEnrollments: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
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

vi.mock("@/lib/db", () => ({
  prisma: {
    lecturerCourseAssignment: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    semester: {
      findUniqueOrThrow: vi.fn(),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ lecturerCourseAssignment: { create: vi.fn() } })
    ),
  },
}));

import { requireRole } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { autoEnrollClassIntoAssignment, auditAutoEnrollments } from "@/lib/enrollment";
import { prisma } from "@/lib/db";
import { createAssignment, deleteAssignment, bulkCreateAssignments } from "./actions";

const validInput = {
  lecturerId: "lect-1",
  courseId: "course-1",
  classId: "class-1",
  semesterId: "sem-1",
};

describe("createAssignment", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requireRole).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue(null);
    vi.mocked(autoEnrollClassIntoAssignment).mockResolvedValue([]);
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) =>
      (fn as (tx: unknown) => unknown)({
        lecturerCourseAssignment: {
          create: vi.fn().mockResolvedValue({ id: "assign-1", ...validInput }),
        },
      })
    );
  });

  it("blocks a second lecturer for the same course+class+semester, naming the existing one", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue({
      id: "assign-existing",
      lecturer: { user: { fullName: "Dr. Existing" } },
    } as never);

    await expect(createAssignment(validInput)).rejects.toThrow(
      /already has a lecturer \(Dr\. Existing\)\. Use Dean ownership transfer/
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("falls back to a generic conflict message if a duplicate slips past the pre-check (race condition)", async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(duplicateError());

    await expect(createAssignment(validInput)).rejects.toThrow(
      /already has a lecturer\. Use Dean ownership transfer/
    );
  });

  it("creates the assignment and auto-enrolls when no conflict exists", async () => {
    await createAssignment(validInput);

    expect(autoEnrollClassIntoAssignment).toHaveBeenCalled();
    expect(auditAutoEnrollments).toHaveBeenCalledWith("admin-1", []);
  });

  it("enforces admin-only access before touching anything", async () => {
    vi.mocked(requireRole).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(createAssignment(validInput)).rejects.toThrow("FORBIDDEN");
    expect(prisma.lecturerCourseAssignment.findFirst).not.toHaveBeenCalled();
  });
});

describe("bulkCreateAssignments", () => {
  const rows = [
    { lecturerId: "lect-1", courseId: "course-1", classId: "class-1" },
    { lecturerId: "lect-1", courseId: "course-2", classId: "class-1" },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requireRole).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.semester.findUniqueOrThrow).mockResolvedValue({
      id: "sem-1",
      isClosed: false,
    } as never);
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([]);
    vi.mocked(autoEnrollClassIntoAssignment).mockResolvedValue([]);
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) =>
      (fn as (tx: unknown) => unknown)({
        lecturerCourseAssignment: {
          create: vi.fn().mockImplementation(({ data }) =>
            Promise.resolve({ id: `assign-${data.courseId}`, ...data })
          ),
        },
      })
    );
  });

  it("refuses to assign into a closed semester", async () => {
    vi.mocked(prisma.semester.findUniqueOrThrow).mockResolvedValue({
      id: "sem-1",
      isClosed: true,
    } as never);

    await expect(
      bulkCreateAssignments({ semesterId: "sem-1", rows })
    ).rejects.toThrow("CLOSED_SEMESTER");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("creates every row in one transaction when nothing conflicts", async () => {
    const result = await bulkCreateAssignments({ semesterId: "sem-1", rows });

    expect(result.created).toBe(2);
    expect(result.skipped).toBe(0);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(autoEnrollClassIntoAssignment).toHaveBeenCalledTimes(2);
  });

  it("skips a row already assigned to a different lecturer, naming them, without failing the batch", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      {
        courseId: "course-1",
        classId: "class-1",
        lecturerId: "lect-9",
        lecturer: { user: { fullName: "Dr. Existing" } },
      },
    ] as never);

    const result = await bulkCreateAssignments({ semesterId: "sem-1", rows });

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.results).toContainEqual({
      lecturerId: "lect-1",
      courseId: "course-1",
      classId: "class-1",
      status: "skipped",
      reason: "Already assigned to Dr. Existing",
    });
  });

  it("skips a course+class repeated within the same batch as a duplicate row", async () => {
    const dupRows = [
      { lecturerId: "lect-1", courseId: "course-1", classId: "class-1" },
      { lecturerId: "lect-2", courseId: "course-1", classId: "class-1" },
    ];

    const result = await bulkCreateAssignments({ semesterId: "sem-1", rows: dupRows });

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.results[1]).toMatchObject({
      status: "skipped",
      reason: "Duplicate row in this batch",
    });
  });

  it("never attempts a create when every row is skipped (no empty transaction)", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      {
        courseId: "course-1",
        classId: "class-1",
        lecturerId: "lect-9",
        lecturer: { user: { fullName: "Dr. Existing" } },
      },
      {
        courseId: "course-2",
        classId: "class-1",
        lecturerId: "lect-9",
        lecturer: { user: { fullName: "Dr. Existing" } },
      },
    ] as never);

    const result = await bulkCreateAssignments({ semesterId: "sem-1", rows });

    expect(result.created).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("audits BULK_ASSIGNED with counts after the transaction commits", async () => {
    await bulkCreateAssignments({ semesterId: "sem-1", rows });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "BULK_ASSIGNED",
        entity: "LecturerCourseAssignment",
        newValue: {
          semesterId: "sem-1",
          requested: 2,
          created: 2,
          skipped: 0,
        },
      })
    );
  });

  it("enforces admin-only access before touching anything", async () => {
    vi.mocked(requireRole).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(
      bulkCreateAssignments({ semesterId: "sem-1", rows })
    ).rejects.toThrow("FORBIDDEN");
    expect(prisma.semester.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe("deleteAssignment", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requireRole).mockResolvedValue(mockAdmin as never);
  });

  it("enforces admin-only access", async () => {
    vi.mocked(requireRole).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(deleteAssignment("assign-1")).rejects.toThrow("FORBIDDEN");
    expect(prisma.lecturerCourseAssignment.delete).not.toHaveBeenCalled();
  });
});
