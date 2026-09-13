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
    class: { findFirst: vi.fn(), findMany: vi.fn() },
    specialExamPeriod: { findUnique: vi.fn() },
    studentCourseEnrollment: { findMany: vi.fn() },
    lecturerCourseAssignment: { findMany: vi.fn() },
    missedExamRecord: {
      createMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("@/lib/dean-scope", () => ({
  getDeanDepartmentIds: vi.fn(),
  classDeanWhere: vi.fn((ids: string[]) => ({
    program: { departmentId: { in: ids } },
  })),
  missedExamRecordDeanWhere: vi.fn((ids: string[]) => ({
    assignment: { class: { program: { departmentId: { in: ids } } } },
  })),
}));

import { requirePermission, getUserAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import {
  getClassesForLevelAction,
  getMissedExamGridRowsAction,
  recordMissedExamsBulk,
  updateMissedExamRecord,
  deleteMissedExamRecord,
} from "./actions";

function mockRoles(roleNames: string[]) {
  vi.mocked(getUserAccess).mockResolvedValue({
    permissions: new Set(),
    roleNames,
  } as never);
}

const enrollmentRow = {
  id: "enr-1",
  courseId: "course-1",
  student: { id: "student-1", studentNo: "S1", fullName: "Alice" },
  course: { id: "course-1", name: "Databases", code: "CS201" },
};
const assignmentRow = { id: "assign-1", courseId: "course-1" };
const period = { id: "period-1", name: "2026-2027 — Semester 1", semesterId: "sem-1" };

describe("getClassesForLevelAction", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.class.findMany).mockResolvedValue([]);
  });

  it("enforces exam.records.manage", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(getClassesForLevelAction(1)).rejects.toThrow("FORBIDDEN");
  });

  it("merges the dean scope for a DEAN caller", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-1"]);

    await getClassesForLevelAction(3);

    expect(prisma.class.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletedAt: null,
          currentSemesterNumber: 3,
          program: { departmentId: { in: ["dept-1"] } },
        },
      })
    );
  });
});

describe("getMissedExamGridRowsAction", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.class.findFirst).mockResolvedValue({ id: "class-1" } as never);
    vi.mocked(prisma.specialExamPeriod.findUnique).mockResolvedValue({
      semesterId: "sem-1",
    } as never);
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([
      enrollmentRow,
    ] as never);
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      assignmentRow,
    ] as never);
  });

  it("enforces exam.records.manage", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(getMissedExamGridRowsAction("class-1", "period-1")).rejects.toThrow(
      "FORBIDDEN"
    );
  });

  it("returns [] for a class outside a Dean's scope, without ever resolving the period", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-1"]);
    vi.mocked(prisma.class.findFirst).mockResolvedValue(null);

    const rows = await getMissedExamGridRowsAction("class-1", "period-1");

    expect(rows).toEqual([]);
    expect(prisma.specialExamPeriod.findUnique).not.toHaveBeenCalled();
  });

  it("returns [] for an unknown period", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.specialExamPeriod.findUnique).mockResolvedValue(null);

    const rows = await getMissedExamGridRowsAction("class-1", "period-1");

    expect(rows).toEqual([]);
  });

  it("resolves the grid rows via the period's own semester", async () => {
    mockRoles(["ADMIN"]);

    const rows = await getMissedExamGridRowsAction("class-1", "period-1");

    expect(rows).toEqual([
      {
        enrollmentId: "enr-1",
        studentId: "student-1",
        studentNo: "S1",
        studentFullName: "Alice",
        courseId: "course-1",
        courseName: "Databases",
        courseCode: "CS201",
        assignmentId: "assign-1",
      },
    ]);
  });
});

describe("recordMissedExamsBulk", () => {
  const validInput = {
    specialExamPeriodId: "period-1",
    classId: "class-1",
    rows: [
      {
        enrollmentId: "enr-1",
        studentId: "student-1",
        assignmentId: "assign-1",
        examType: "MIDTERM" as const,
        reasonType: "ILLNESS" as const,
        reasonNote: "Hospitalized",
      },
    ],
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.specialExamPeriod.findUnique).mockResolvedValue(period as never);
    vi.mocked(prisma.class.findFirst).mockResolvedValue({
      id: "class-1",
      name: "CMS26-A-FT",
    } as never);
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([
      enrollmentRow,
    ] as never);
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      assignmentRow,
    ] as never);
  });

  it("enforces exam.records.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(recordMissedExamsBulk(validInput)).rejects.toThrow("FORBIDDEN");
    expect(prisma.specialExamPeriod.findUnique).not.toHaveBeenCalled();
  });

  it("throws PERIOD_NOT_FOUND for an unknown period", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.specialExamPeriod.findUnique).mockResolvedValue(null);

    await expect(recordMissedExamsBulk(validInput)).rejects.toThrow("PERIOD_NOT_FOUND");
    expect(prisma.missedExamRecord.createMany).not.toHaveBeenCalled();
  });

  it("throws CLASS_NOT_FOUND when the class doesn't resolve (out of a Dean's scope)", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-1"]);
    vi.mocked(prisma.class.findFirst).mockResolvedValue(null);

    await expect(recordMissedExamsBulk(validInput)).rejects.toThrow("CLASS_NOT_FOUND");
    expect(prisma.missedExamRecord.createMany).not.toHaveBeenCalled();
  });

  it("silently skips a row whose (studentId, assignmentId) doesn't match a real enrollment — never force-created", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([]);

    const result = await recordMissedExamsBulk(validInput);

    expect(result).toEqual({ created: 0, skipped: 1 });
    expect(prisma.missedExamRecord.createMany).not.toHaveBeenCalled();
  });

  it("creates only the genuinely-valid rows via one createMany, denormalizing courseId/specialExamPeriodId from the resolved match", async () => {
    mockRoles(["ADMIN"]);

    const result = await recordMissedExamsBulk(validInput);

    expect(result).toEqual({ created: 1, skipped: 0 });
    expect(prisma.missedExamRecord.createMany).toHaveBeenCalledWith({
      data: [
        {
          studentId: "student-1",
          courseId: "course-1",
          assignmentId: "assign-1",
          specialExamPeriodId: "period-1",
          examType: "MIDTERM",
          reasonType: "ILLNESS",
          reasonNote: "Hospitalized",
          recordedById: "user-1",
        },
      ],
    });
  });

  it("audits ONE summary entry per bulk submission, not one per row", async () => {
    mockRoles(["ADMIN"]);

    await recordMissedExamsBulk(validInput);

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        action: "MISSED_EXAM_BULK_RECORDED",
        entity: "SpecialExamPeriod",
        entityId: "period-1",
        newValue: expect.objectContaining({
          createdCount: 1,
          skippedCount: 0,
          className: "CMS26-A-FT",
        }),
      })
    );
  });

  it("stores a null reasonNote when omitted", async () => {
    mockRoles(["ADMIN"]);

    await recordMissedExamsBulk({
      ...validInput,
      rows: [{ ...validInput.rows[0], reasonNote: undefined }],
    });

    expect(prisma.missedExamRecord.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ reasonNote: null })],
    });
  });
});

const existingRecord = {
  id: "record-1",
  examType: "MIDTERM",
  reasonType: "ILLNESS",
  reasonNote: "Old note",
  student: { studentNo: "S1001", fullName: "Jane Doe" },
  course: { name: "Databases", code: "CS201" },
};

describe("updateMissedExamRecord", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.missedExamRecord.findFirst).mockResolvedValue(
      existingRecord as never
    );
    vi.mocked(prisma.missedExamRecord.update).mockResolvedValue({
      ...existingRecord,
      examType: "BOTH",
      reasonType: "EMERGENCY",
      reasonNote: "New note",
    } as never);
  });

  const validInput = {
    examType: "BOTH" as const,
    reasonType: "EMERGENCY" as const,
    reasonNote: "New note",
  };

  it("enforces exam.records.manage (the same key that gates recording, per CLAUDE.md)", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(updateMissedExamRecord("record-1", validInput)).rejects.toThrow(
      "FORBIDDEN"
    );
    expect(prisma.missedExamRecord.findFirst).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND for a record outside a Dean's scope, never leaking its existence", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-1"]);
    vi.mocked(prisma.missedExamRecord.findFirst).mockResolvedValue(null);

    await expect(updateMissedExamRecord("record-1", validInput)).rejects.toThrow(
      "NOT_FOUND"
    );
    expect(prisma.missedExamRecord.update).not.toHaveBeenCalled();
  });

  it("scopes the lookup through the Dean's own recordScope", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-1"]);

    await updateMissedExamRecord("record-1", validInput);

    expect(prisma.missedExamRecord.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "record-1",
          assignment: { class: { program: { departmentId: { in: ["dept-1"] } } } },
        },
      })
    );
  });

  it("updates only examType/reasonType/reasonNote and audits old->new", async () => {
    mockRoles(["ADMIN"]);

    await updateMissedExamRecord("record-1", validInput);

    expect(prisma.missedExamRecord.update).toHaveBeenCalledWith({
      where: { id: "record-1" },
      data: { examType: "BOTH", reasonType: "EMERGENCY", reasonNote: "New note" },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        action: "MISSED_EXAM_UPDATED",
        entity: "MissedExamRecord",
        entityId: "record-1",
        oldValue: {
          examType: "MIDTERM",
          reasonType: "ILLNESS",
          reasonNote: "Old note",
        },
        newValue: {
          examType: "BOTH",
          reasonType: "EMERGENCY",
          reasonNote: "New note",
        },
      })
    );
  });

  it("stores a null reasonNote when cleared", async () => {
    mockRoles(["ADMIN"]);

    await updateMissedExamRecord("record-1", { ...validInput, reasonNote: undefined });

    expect(prisma.missedExamRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reasonNote: null }) })
    );
  });
});

describe("deleteMissedExamRecord", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.missedExamRecord.findFirst).mockResolvedValue(
      existingRecord as never
    );
  });

  it("enforces exam.records.delete — a SEPARATE key from exam.records.manage", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(deleteMissedExamRecord("record-1")).rejects.toThrow("FORBIDDEN");
    expect(requirePermission).toHaveBeenCalledWith("exam.records.delete");
    expect(prisma.missedExamRecord.findFirst).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND for a record outside a Dean's scope, never leaking its existence", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-1"]);
    vi.mocked(prisma.missedExamRecord.findFirst).mockResolvedValue(null);

    await expect(deleteMissedExamRecord("record-1")).rejects.toThrow("NOT_FOUND");
    expect(prisma.missedExamRecord.delete).not.toHaveBeenCalled();
  });

  it("deletes the record and audits what was deleted, by whom", async () => {
    mockRoles(["ADMIN"]);

    await deleteMissedExamRecord("record-1");

    expect(prisma.missedExamRecord.delete).toHaveBeenCalledWith({
      where: { id: "record-1" },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        action: "MISSED_EXAM_DELETED",
        entity: "MissedExamRecord",
        entityId: "record-1",
        oldValue: {
          studentNo: "S1001",
          studentName: "Jane Doe",
          courseName: "Databases",
          examType: "MIDTERM",
          reasonType: "ILLNESS",
        },
      })
    );
  });
});
