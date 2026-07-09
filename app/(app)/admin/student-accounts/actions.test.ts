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
