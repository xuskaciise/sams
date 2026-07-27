import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAdmin = { id: "admin-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    role: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "role-student", name: "STUDENT" }),
    },
    student: {
      findMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    user: {
      create: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(async (fn) => {
      if (typeof fn === "function") {
        return fn({
          user: { create: vi.fn().mockResolvedValue({ id: "new-user-1" }) },
          student: { update: vi.fn() },
        });
      }
      return fn;
    }),
  },
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("argon2", () => ({
  default: {
    hash: vi.fn().mockResolvedValue("hashed-temp-password"),
    argon2id: 2,
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  generateAccountsForClass,
  generateAccountForStudent,
  resetStudentPassword,
} from "./actions";

describe("student accounts actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
  });

  describe("generateAccountsForClass", () => {
    it("returns no created accounts, and never opens a transaction, when every student already has one", async () => {
      vi.mocked(prisma.student.findMany).mockResolvedValue([]);

      const result = await generateAccountsForClass("class-1");

      expect(result).toEqual({ created: [] });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("only queries students without an account for the class", async () => {
      vi.mocked(prisma.student.findMany).mockResolvedValue([]);

      await generateAccountsForClass("class-1");

      expect(prisma.student.findMany).toHaveBeenCalledWith({
        where: { classId: "class-1", userId: null },
      });
    });

    // Regression: password hashing used to happen INSIDE the
    // $transaction callback, one argon2.hash per student. argon2id is
    // deliberately slow, so a class with more than a handful of students
    // blew past Prisma's ~5s interactive-transaction timeout and aborted
    // the whole batch with "Transaction already closed". Hashing must
    // happen before the transaction opens.
    it("hashes every student's password BEFORE opening the transaction, not inside it", async () => {
      vi.mocked(prisma.student.findMany).mockResolvedValue([
        { id: "s1", studentNo: "CMS-101", fullName: "Amina Yusuf", userId: null },
        { id: "s2", studentNo: "CMS-102", fullName: "Omar Ali", userId: null },
        { id: "s3", studentNo: "CMS-103", fullName: "Hodan Warsame", userId: null },
      ] as never);

      let created = 0;
      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        if (typeof fn !== "function") return fn;
        return fn({
          user: {
            create: vi.fn().mockImplementation(async () => ({ id: `user-${++created}` })),
          },
          student: { update: vi.fn() },
        } as never);
      });

      const argon2 = (await import("argon2")).default;
      await generateAccountsForClass("class-1");

      const lastHashCallOrder = Math.max(
        ...vi.mocked(argon2.hash).mock.invocationCallOrder
      );
      const transactionCallOrder = vi.mocked(prisma.$transaction).mock
        .invocationCallOrder[0];

      expect(vi.mocked(argon2.hash).mock.calls.length).toBe(3);
      expect(lastHashCallOrder).toBeLessThan(transactionCallOrder);
    });

    it("creates one account per student, each with its own distinct temp password", async () => {
      vi.mocked(prisma.student.findMany).mockResolvedValue([
        { id: "s1", studentNo: "CMS-101", fullName: "Amina Yusuf", userId: null },
        { id: "s2", studentNo: "CMS-102", fullName: "Omar Ali", userId: null },
      ] as never);

      let created = 0;
      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        if (typeof fn !== "function") return fn;
        return fn({
          user: {
            create: vi.fn().mockImplementation(async () => ({ id: `user-${++created}` })),
          },
          student: { update: vi.fn() },
        } as never);
      });

      const result = await generateAccountsForClass("class-1");

      expect(result.created).toHaveLength(2);
      expect(result.created[0].studentNo).toBe("CMS-101");
      expect(result.created[1].studentNo).toBe("CMS-102");
      // Two distinct students never share a temp password (each gets its
      // own real randomBytes-generated value — not the SAME regenerated
      // one being hashed and returned separately, which was a bug caught
      // during this fix's own review).
      expect(result.created[0].tempPassword).not.toBe(result.created[1].tempPassword);
    });
  });

  describe("generateAccountForStudent", () => {
    it("refuses to generate a second account for a student who already has one", async () => {
      vi.mocked(prisma.student.findUniqueOrThrow).mockResolvedValue({
        id: "student-1",
        userId: "existing-user",
        studentNo: "CMS-101",
        fullName: "Amina Yusuf",
      } as never);

      await expect(generateAccountForStudent("student-1")).rejects.toThrow(
        "ALREADY_HAS_ACCOUNT"
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("generates an account for a student without one", async () => {
      vi.mocked(prisma.student.findUniqueOrThrow).mockResolvedValue({
        id: "student-1",
        userId: null,
        studentNo: "CMS-101",
        fullName: "Amina Yusuf",
      } as never);

      const result = await generateAccountForStudent("student-1");

      expect(result.tempPassword).toBeTruthy();
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it("enforces admin-only access", async () => {
      vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

      await expect(generateAccountForStudent("student-1")).rejects.toThrow(
        "FORBIDDEN"
      );
      expect(prisma.student.findUniqueOrThrow).not.toHaveBeenCalled();
    });
  });

  describe("resetStudentPassword", () => {
    it("refuses to reset a password for a student with no account", async () => {
      vi.mocked(prisma.student.findUniqueOrThrow).mockResolvedValue({
        id: "student-1",
        userId: null,
        studentNo: "CMS-101",
      } as never);

      await expect(resetStudentPassword("student-1")).rejects.toThrow(
        "NO_ACCOUNT"
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("resets the password and clears any lockout for an existing account", async () => {
      vi.mocked(prisma.student.findUniqueOrThrow).mockResolvedValue({
        id: "student-1",
        userId: "existing-user",
        studentNo: "CMS-101",
      } as never);

      const result = await resetStudentPassword("student-1");

      expect(result.tempPassword).toBeTruthy();
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "existing-user" },
        data: expect.objectContaining({
          mustChangePw: true,
          failedLogins: 0,
          lockedUntil: null,
        }),
      });
    });
  });
});
