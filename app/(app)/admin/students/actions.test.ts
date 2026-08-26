import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const mockAdmin = { id: "admin-1" };

function p2002(target: string[]) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target },
  });
}

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

function makeTx() {
  return {
    student: { create: vi.fn() },
  };
}
let tx = makeTx();

vi.mock("@/lib/db", () => ({
  prisma: {
    student: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
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
import {
  registerStudent,
  updateStudentPhoneNumber,
  deactivateStudent,
  reactivateStudent,
} from "./actions";

const validRegistration = {
  studentNo: "S1001",
  fullName: "Jane Doe",
  gender: "FEMALE" as const,
  classId: "class-1",
  phoneNumber: "",
};

describe("registerStudent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx = makeTx();
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) =>
      (fn as (tx: unknown) => unknown)(tx)
    );
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(tx.student.create).mockResolvedValue({
      id: "student-1",
      studentNo: "S1001",
      fullName: "Jane Doe",
      classId: "class-1",
    } as never);
    vi.mocked(autoEnrollStudentIntoClassCourses).mockResolvedValue([]);
  });

  it("requires students.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(registerStudent(validRegistration)).rejects.toThrow(
      "FORBIDDEN"
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("creates the student, auto-enrolls, and audits both", async () => {
    vi.mocked(autoEnrollStudentIntoClassCourses).mockResolvedValue([
      { enrollmentId: "enr-1", studentId: "student-1", courseId: "c-1", semesterId: "sem-1" },
    ]);

    const result = await registerStudent(validRegistration);

    expect(tx.student.create).toHaveBeenCalledWith({
      data: {
        studentNo: "S1001",
        fullName: "Jane Doe",
        gender: "FEMALE",
        classId: "class-1",
        phoneNumber: null,
      },
    });
    expect(autoEnrollStudentIntoClassCourses).toHaveBeenCalledWith(
      tx,
      "student-1",
      "class-1"
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "STUDENT_REGISTERED",
        entity: "Student",
        entityId: "student-1",
      })
    );
    expect(auditAutoEnrollments).toHaveBeenCalledWith("admin-1", [
      { enrollmentId: "enr-1", studentId: "student-1", courseId: "c-1", semesterId: "sem-1" },
    ]);
    expect(result).toMatchObject({ id: "student-1" });
  });

  it("translates a duplicate student_no (P2002) into STUDENT_NO_TAKEN", async () => {
    vi.mocked(tx.student.create).mockRejectedValue(p2002(["student_no"]));

    await expect(registerStudent(validRegistration)).rejects.toThrow(
      "STUDENT_NO_TAKEN"
    );
    expect(audit).not.toHaveBeenCalled();
  });

  // Regression test: autoEnrollStudentIntoClassCourses now does an extra
  // tx.student.findUnique (the isActive guard) on top of its existing
  // queries — this transaction previously ran with Prisma's tight
  // defaults (5s timeout, 2s maxWait) and a real production report showed
  // it failing with a generic, unrecognized error once that extra
  // round-trip was added. Same fix/margin as every other bulk/multi-query
  // interactive transaction in this codebase.
  it("opens the transaction with an explicit timeout margin (BULK_TRANSACTION_OPTIONS)", async () => {
    await registerStudent(validRegistration);

    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 30000, maxWait: 10000 }
    );
  });
});

describe("updateStudentPhoneNumber", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.student.findUniqueOrThrow).mockResolvedValue({
      id: "student-1",
      phoneNumber: null,
    } as never);
    vi.mocked(prisma.student.update).mockResolvedValue({
      id: "student-1",
      phoneNumber: "+252611111111",
    } as never);
  });

  it("requires students.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(
      updateStudentPhoneNumber("student-1", { phoneNumber: "+252611111111" })
    ).rejects.toThrow("FORBIDDEN");
    expect(prisma.student.update).not.toHaveBeenCalled();
  });

  it("rejects a malformed phone number", async () => {
    await expect(
      updateStudentPhoneNumber("student-1", { phoneNumber: "not-a-phone" })
    ).rejects.toThrow();
    expect(prisma.student.update).not.toHaveBeenCalled();
  });

  it("saves a valid phone number", async () => {
    await updateStudentPhoneNumber("student-1", { phoneNumber: "+252611111111" });

    expect(prisma.student.update).toHaveBeenCalledWith({
      where: { id: "student-1" },
      data: { phoneNumber: "+252611111111" },
    });
  });

  it("treats an empty string as clearing the phone number", async () => {
    await updateStudentPhoneNumber("student-1", { phoneNumber: "" });

    expect(prisma.student.update).toHaveBeenCalledWith({
      where: { id: "student-1" },
      data: { phoneNumber: null },
    });
  });

  it("audits STUDENT_PHONE_UPDATED with old and new values", async () => {
    await updateStudentPhoneNumber("student-1", { phoneNumber: "+252611111111" });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "STUDENT_PHONE_UPDATED",
        entity: "Student",
        entityId: "student-1",
        oldValue: { phoneNumber: null },
        newValue: { phoneNumber: "+252611111111" },
      })
    );
  });
});

describe("deactivateStudent / reactivateStudent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.student.update).mockResolvedValue({
      id: "student-1",
      studentNo: "S1001",
      fullName: "Amina Yusuf",
      isActive: false,
    } as never);
  });

  it("deactivateStudent requires students.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(deactivateStudent("student-1")).rejects.toThrow("FORBIDDEN");
    expect(prisma.student.update).not.toHaveBeenCalled();
  });

  it("deactivateStudent sets isActive false and audits it", async () => {
    await deactivateStudent("student-1");

    expect(prisma.student.update).toHaveBeenCalledWith({
      where: { id: "student-1" },
      data: { isActive: false },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "STUDENT_DEACTIVATED",
        entity: "Student",
        entityId: "student-1",
        newValue: { studentNo: "S1001", fullName: "Amina Yusuf" },
      })
    );
  });

  it("reactivateStudent requires students.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(reactivateStudent("student-1")).rejects.toThrow("FORBIDDEN");
    expect(prisma.student.update).not.toHaveBeenCalled();
  });

  it("reactivateStudent sets isActive true and audits it", async () => {
    vi.mocked(prisma.student.update).mockResolvedValue({
      id: "student-1",
      studentNo: "S1001",
      fullName: "Amina Yusuf",
      isActive: true,
    } as never);

    await reactivateStudent("student-1");

    expect(prisma.student.update).toHaveBeenCalledWith({
      where: { id: "student-1" },
      data: { isActive: true },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "STUDENT_REACTIVATED",
        entity: "Student",
        entityId: "student-1",
      })
    );
  });
});
