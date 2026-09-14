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
    specialExamPeriod: { findUnique: vi.fn() },
    course: { findMany: vi.fn() },
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
  studentDeanWhere: vi.fn((ids: string[]) => ({
    class: { program: { departmentId: { in: ids } } },
  })),
  missedExamRecordDeanWhere: vi.fn((ids: string[]) => ({
    student: { class: { program: { departmentId: { in: ids } } } },
  })),
}));

import { requirePermission, getUserAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import {
  lookupStudentForMissedExam,
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

const student = { id: "student-1", studentNo: "S1001", fullName: "Jane Doe" };
const allCourses = [
  { id: "course-1", name: "Databases", code: "CS201" },
  { id: "course-2", name: "Networking", code: "CS202" },
];
const period = {
  id: "period-1",
  name: "2026-2027 — Semester 1",
  semesterId: "sem-1",
  status: "OPEN",
};

describe("lookupStudentForMissedExam", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.student.findFirst).mockResolvedValue(student as never);
    vi.mocked(prisma.course.findMany).mockResolvedValue(allCourses as never);
  });

  it("enforces exam.records.manage", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(lookupStudentForMissedExam("S1001")).rejects.toThrow("FORBIDDEN");
    expect(prisma.student.findFirst).not.toHaveBeenCalled();
  });

  it("returns null without querying when the input is blank", async () => {
    mockRoles(["ADMIN"]);
    const result = await lookupStudentForMissedExam("   ");
    expect(result).toBeNull();
    expect(prisma.student.findFirst).not.toHaveBeenCalled();
  });

  it("returns null for an unknown/out-of-scope student, never leaking existence", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-1"]);
    vi.mocked(prisma.student.findFirst).mockResolvedValue(null);

    const result = await lookupStudentForMissedExam("S1001");

    expect(result).toBeNull();
    expect(prisma.course.findMany).not.toHaveBeenCalled();
  });

  it("returns the student plus ALL active courses in the system — never filtered by enrollment", async () => {
    mockRoles(["ADMIN"]);

    const result = await lookupStudentForMissedExam("S1001");

    expect(result).toEqual({ student, courses: allCourses });
    expect(prisma.course.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } })
    );
  });

  it("trims the input before looking it up", async () => {
    mockRoles(["ADMIN"]);
    await lookupStudentForMissedExam("  S1001  ");
    expect(prisma.student.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ studentNo: { equals: "S1001", mode: "insensitive" } }),
      })
    );
  });
});

describe("recordMissedExamsBulk", () => {
  const validInput = {
    specialExamPeriodId: "period-1",
    studentId: "student-1",
    rows: [
      {
        courseId: "course-1",
        examType: "MIDTERM" as const,
        reasonType: "ILLNESS" as const,
        reasonNote: "Hospitalized",
      },
    ],
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.student.findFirst).mockResolvedValue(student as never);
    vi.mocked(prisma.specialExamPeriod.findUnique).mockResolvedValue(period as never);
    vi.mocked(prisma.course.findMany).mockResolvedValue([
      { id: "course-1" },
    ] as never);
  });

  it("enforces exam.records.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(recordMissedExamsBulk(validInput)).rejects.toThrow("FORBIDDEN");
    expect(prisma.student.findFirst).not.toHaveBeenCalled();
  });

  it("throws STUDENT_NOT_FOUND when the student doesn't resolve (out of a Dean's scope)", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-1"]);
    vi.mocked(prisma.student.findFirst).mockResolvedValue(null);

    await expect(recordMissedExamsBulk(validInput)).rejects.toThrow("STUDENT_NOT_FOUND");
    expect(prisma.missedExamRecord.createMany).not.toHaveBeenCalled();
  });

  it("throws PERIOD_NOT_FOUND for an unknown period", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.specialExamPeriod.findUnique).mockResolvedValue(null);

    await expect(recordMissedExamsBulk(validInput)).rejects.toThrow("PERIOD_NOT_FOUND");
    expect(prisma.missedExamRecord.createMany).not.toHaveBeenCalled();
  });

  it("throws PERIOD_CLOSED — a REAL server-side boundary, not just a UI convenience — and never writes", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.specialExamPeriod.findUnique).mockResolvedValue({
      ...period,
      status: "CLOSED",
    } as never);

    await expect(recordMissedExamsBulk(validInput)).rejects.toThrow("PERIOD_CLOSED");
    expect(prisma.missedExamRecord.createMany).not.toHaveBeenCalled();
  });

  it("silently skips a row whose courseId isn't a real, active course — never force-created", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.course.findMany).mockResolvedValue([]);

    const result = await recordMissedExamsBulk(validInput);

    expect(result).toEqual({ created: 0, skipped: 1 });
    expect(prisma.missedExamRecord.createMany).not.toHaveBeenCalled();
  });

  it("creates only the genuinely-valid rows via one createMany, keyed by courseId", async () => {
    mockRoles(["ADMIN"]);

    const result = await recordMissedExamsBulk(validInput);

    expect(result).toEqual({ created: 1, skipped: 0 });
    expect(prisma.missedExamRecord.createMany).toHaveBeenCalledWith({
      data: [
        {
          studentId: "student-1",
          courseId: "course-1",
          specialExamPeriodId: "period-1",
          examType: "MIDTERM",
          reasonType: "ILLNESS",
          reasonNote: "Hospitalized",
          recordedById: "user-1",
        },
      ],
    });
  });

  it("regression: a provided reasonNote is persisted verbatim — bug report was 'Reason Note not appearing after saving' (turned out to be a display bug, not this save path)", async () => {
    mockRoles(["ADMIN"]);

    await recordMissedExamsBulk({
      ...validInput,
      rows: [{ ...validInput.rows[0], reasonNote: "Doctor's note attached, see file 42" }],
    });

    expect(prisma.missedExamRecord.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ reasonNote: "Doctor's note attached, see file 42" }),
      ],
    });
  });

  it("audits ONE summary entry per bulk submission, keyed to the student, not one per row", async () => {
    mockRoles(["ADMIN"]);

    await recordMissedExamsBulk(validInput);

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        action: "MISSED_EXAM_BULK_RECORDED",
        entity: "Student",
        entityId: "student-1",
        newValue: expect.objectContaining({
          createdCount: 1,
          skippedCount: 0,
          studentNo: "S1001",
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

  it("scopes the lookup through the Dean's own recordScope (now via the student directly)", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-1"]);

    await updateMissedExamRecord("record-1", validInput);

    expect(prisma.missedExamRecord.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "record-1",
          student: { class: { program: { departmentId: { in: ["dept-1"] } } } },
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

  it("deletes the record and audits what was deleted (via course directly), by whom", async () => {
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
