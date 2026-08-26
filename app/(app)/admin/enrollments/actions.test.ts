import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAdmin = { id: "admin-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

function makeTx() {
  return {
    studentCourseEnrollment: { update: vi.fn(), create: vi.fn() },
    student: { update: vi.fn() },
  };
}
let tx = makeTx();

vi.mock("@/lib/db", () => ({
  prisma: {
    studentCourseEnrollment: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
  },
  BULK_TRANSACTION_OPTIONS: { timeout: 30000, maxWait: 10000 },
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("@/lib/enrollment", () => ({
  autoEnrollStudentIntoClassCourses: vi.fn(),
  auditAutoEnrollments: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import {
  autoEnrollStudentIntoClassCourses,
  auditAutoEnrollments,
} from "@/lib/enrollment";
import { restoreEnrollment, transferEnrollment } from "./actions";

describe("restoreEnrollment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
  });

  it("refuses to restore an enrollment that isn't DROPPED", async () => {
    vi.mocked(prisma.studentCourseEnrollment.findUniqueOrThrow).mockResolvedValue(
      { id: "enr-1", status: "ACTIVE" } as never
    );

    await expect(restoreEnrollment("enr-1")).rejects.toThrow("NOT_DROPPED");
    expect(prisma.studentCourseEnrollment.update).not.toHaveBeenCalled();
  });

  it("restores a DROPPED enrollment back to ACTIVE", async () => {
    vi.mocked(prisma.studentCourseEnrollment.findUniqueOrThrow).mockResolvedValue(
      { id: "enr-1", status: "DROPPED" } as never
    );

    await restoreEnrollment("enr-1");

    expect(prisma.studentCourseEnrollment.update).toHaveBeenCalledWith({
      where: { id: "enr-1" },
      data: { status: "ACTIVE" },
    });
  });

  it("enforces admin-only access", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(restoreEnrollment("enr-1")).rejects.toThrow("FORBIDDEN");
    expect(prisma.studentCourseEnrollment.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe("transferEnrollment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx = makeTx();
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) =>
      (fn as (tx: unknown) => unknown)(tx)
    );
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.studentCourseEnrollment.findUniqueOrThrow).mockResolvedValue(
      {
        id: "enr-1",
        studentId: "student-1",
        courseId: "course-1",
        semesterId: "sem-1",
        status: "ACTIVE",
      } as never
    );
    vi.mocked(tx.studentCourseEnrollment.create).mockResolvedValue({
      id: "enr-2",
    } as never);
    vi.mocked(autoEnrollStudentIntoClassCourses).mockResolvedValue([]);
  });

  it("refuses to transfer an enrollment that isn't ACTIVE", async () => {
    vi.mocked(prisma.studentCourseEnrollment.findUniqueOrThrow).mockResolvedValue(
      { id: "enr-1", status: "DROPPED" } as never
    );

    await expect(
      transferEnrollment("enr-1", { newClassId: "class-2" })
    ).rejects.toThrow("NOT_ACTIVE");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("demotes the old enrollment, creates the new one, moves the student, and auto-enrolls", async () => {
    await transferEnrollment("enr-1", { newClassId: "class-2" });

    expect(tx.studentCourseEnrollment.update).toHaveBeenCalledWith({
      where: { id: "enr-1" },
      data: { status: "TRANSFERRED" },
    });
    expect(tx.studentCourseEnrollment.create).toHaveBeenCalledWith({
      data: {
        studentId: "student-1",
        courseId: "course-1",
        semesterId: "sem-1",
        classId: "class-2",
      },
    });
    expect(tx.studentCourseEnrollment.update).toHaveBeenCalledWith({
      where: { id: "enr-1" },
      data: { transferredToId: "enr-2" },
    });
    expect(tx.student.update).toHaveBeenCalledWith({
      where: { id: "student-1" },
      data: { classId: "class-2" },
    });
    expect(autoEnrollStudentIntoClassCourses).toHaveBeenCalledWith(
      tx,
      "student-1",
      "class-2"
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "ENROLLMENT_TRANSFERRED",
        entity: "StudentCourseEnrollment",
        entityId: "enr-1",
        newValue: { newClassId: "class-2" },
      })
    );
  });

  it("audits the auto-enrollments created by the transfer", async () => {
    vi.mocked(autoEnrollStudentIntoClassCourses).mockResolvedValue([
      { enrollmentId: "enr-3", studentId: "student-1", courseId: "c-2", semesterId: "sem-1" },
    ]);

    await transferEnrollment("enr-1", { newClassId: "class-2" });

    expect(auditAutoEnrollments).toHaveBeenCalledWith("admin-1", [
      { enrollmentId: "enr-3", studentId: "student-1", courseId: "c-2", semesterId: "sem-1" },
    ]);
  });

  it("enforces admin-only access", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(
      transferEnrollment("enr-1", { newClassId: "class-2" })
    ).rejects.toThrow("FORBIDDEN");
    expect(prisma.studentCourseEnrollment.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  // Regression test: autoEnrollStudentIntoClassCourses now does an extra
  // tx.student.findUnique (the isActive guard) on top of its existing
  // queries — this transaction previously ran with Prisma's tight
  // defaults (5s timeout, 2s maxWait). Same fix/margin as registerStudent,
  // which shares this exact risk through the same helper — see
  // CLAUDE.md's transaction-timeout conventions.
  it("opens the transaction with an explicit timeout margin (BULK_TRANSACTION_OPTIONS)", async () => {
    await transferEnrollment("enr-1", { newClassId: "class-2" });

    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 30000, maxWait: 10000 }
    );
  });
});
