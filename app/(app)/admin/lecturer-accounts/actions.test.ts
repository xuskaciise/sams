import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const mockAdmin = { id: "admin-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    role: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "role-lecturer", name: "LECTURER" }),
    },
    lecturer: {
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
          lecturer: { update: vi.fn() },
        });
      }
      return fn;
    }),
  },
  BULK_TRANSACTION_OPTIONS: { timeout: 30000, maxWait: 10000 },
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
  generateAccountsForDepartment,
  generateAccountForLecturer,
  resetLecturerPassword,
} from "./actions";

function p2002() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target: ["username"] },
  });
}

describe("lecturer accounts actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
  });

  describe("generateAccountsForDepartment", () => {
    it("returns no created accounts, and never opens a transaction, when every lecturer already has one", async () => {
      vi.mocked(prisma.lecturer.findMany).mockResolvedValue([]);

      const result = await generateAccountsForDepartment("dept-1");

      expect(result).toEqual({ created: [], skippedNoPhone: 0 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("only queries lecturers without an account for the department", async () => {
      vi.mocked(prisma.lecturer.findMany).mockResolvedValue([]);

      await generateAccountsForDepartment("dept-1");

      expect(prisma.lecturer.findMany).toHaveBeenCalledWith({
        where: { departmentId: "dept-1", userId: null },
      });
    });

    it("resolves the sentinel null departmentId (Unassigned) straight through", async () => {
      vi.mocked(prisma.lecturer.findMany).mockResolvedValue([]);

      await generateAccountsForDepartment(null);

      expect(prisma.lecturer.findMany).toHaveBeenCalledWith({
        where: { departmentId: null, userId: null },
      });
    });

    // A lecturer without a phone number can't get an account at all (it's
    // their future login identifier) — never fails the whole batch, just
    // reported back so the admin can see who still needs a phone number.
    it("skips lecturers with no phone number, without failing the rest of the batch", async () => {
      vi.mocked(prisma.lecturer.findMany).mockResolvedValue([
        { id: "l1", staffNo: "L001", fullName: "Dr. A", phoneNumber: "+252611111111" },
        { id: "l2", staffNo: "L002", fullName: "Dr. B", phoneNumber: null },
      ] as never);

      let created = 0;
      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        if (typeof fn !== "function") return fn;
        return fn({
          user: {
            create: vi.fn().mockImplementation(async () => ({ id: `user-${++created}` })),
          },
          lecturer: { update: vi.fn() },
        } as never);
      });

      const result = await generateAccountsForDepartment("dept-1");

      expect(result.created).toHaveLength(1);
      expect(result.created[0].staffNo).toBe("L001");
      expect(result.skippedNoPhone).toBe(1);
    });

    // Same regression this app already fixed once for students: argon2id
    // hashing must happen BEFORE the transaction opens, never inside its
    // callback (interactive-transaction timeout risk).
    it("hashes every lecturer's password BEFORE opening the transaction, not inside it", async () => {
      vi.mocked(prisma.lecturer.findMany).mockResolvedValue([
        { id: "l1", staffNo: "L001", fullName: "Dr. A", phoneNumber: "+252611111111" },
        { id: "l2", staffNo: "L002", fullName: "Dr. B", phoneNumber: "+252622222222" },
      ] as never);

      let created = 0;
      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        if (typeof fn !== "function") return fn;
        return fn({
          user: {
            create: vi.fn().mockImplementation(async () => ({ id: `user-${++created}` })),
          },
          lecturer: { update: vi.fn() },
        } as never);
      });

      const argon2 = (await import("argon2")).default;
      await generateAccountsForDepartment("dept-1");

      const lastHashCallOrder = Math.max(
        ...vi.mocked(argon2.hash).mock.invocationCallOrder
      );
      const transactionCallOrder = vi.mocked(prisma.$transaction).mock
        .invocationCallOrder[0];

      expect(vi.mocked(argon2.hash).mock.calls.length).toBe(2);
      expect(lastHashCallOrder).toBeLessThan(transactionCallOrder);
    });

    it("sets username to the lecturer's phone number and email to null", async () => {
      vi.mocked(prisma.lecturer.findMany).mockResolvedValue([
        { id: "l1", staffNo: "L001", fullName: "Dr. A", phoneNumber: "+252611111111" },
      ] as never);

      const createSpy = vi.fn().mockResolvedValue({ id: "user-1" });
      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        if (typeof fn !== "function") return fn;
        return fn({
          user: { create: createSpy },
          lecturer: { update: vi.fn() },
        } as never);
      });

      await generateAccountsForDepartment("dept-1");

      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            username: "+252611111111",
            email: null,
          }),
        })
      );
    });

    it("opens the transaction with an explicit timeout margin (BULK_TRANSACTION_OPTIONS)", async () => {
      vi.mocked(prisma.lecturer.findMany).mockResolvedValue([
        { id: "l1", staffNo: "L001", fullName: "Dr. A", phoneNumber: "+252611111111" },
      ] as never);

      await generateAccountsForDepartment("dept-1");

      expect(prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        { timeout: 30000, maxWait: 10000 }
      );
    });
  });

  describe("generateAccountForLecturer", () => {
    it("refuses to generate a second account for a lecturer who already has one", async () => {
      vi.mocked(prisma.lecturer.findUniqueOrThrow).mockResolvedValue({
        id: "lect-1",
        userId: "existing-user",
        phoneNumber: "+252611111111",
      } as never);

      await expect(generateAccountForLecturer("lect-1")).rejects.toThrow(
        "ALREADY_HAS_ACCOUNT"
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("refuses a lecturer with no phone number", async () => {
      vi.mocked(prisma.lecturer.findUniqueOrThrow).mockResolvedValue({
        id: "lect-1",
        userId: null,
        phoneNumber: null,
      } as never);

      await expect(generateAccountForLecturer("lect-1")).rejects.toThrow(
        "NO_PHONE_NUMBER"
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("generates an account for an eligible lecturer", async () => {
      vi.mocked(prisma.lecturer.findUniqueOrThrow).mockResolvedValue({
        id: "lect-1",
        userId: null,
        staffNo: "L001",
        fullName: "Dr. A",
        phoneNumber: "+252611111111",
      } as never);

      const result = await generateAccountForLecturer("lect-1");

      expect(result.tempPassword).toBeTruthy();
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it("reports a conflict if the phone number is already taken as a username", async () => {
      vi.mocked(prisma.lecturer.findUniqueOrThrow).mockResolvedValue({
        id: "lect-1",
        userId: null,
        phoneNumber: "+252611111111",
      } as never);
      vi.mocked(prisma.$transaction).mockRejectedValue(p2002());

      await expect(generateAccountForLecturer("lect-1")).rejects.toThrow(
        "PHONE_NUMBER_TAKEN"
      );
    });

    it("enforces user.manage access", async () => {
      vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

      await expect(generateAccountForLecturer("lect-1")).rejects.toThrow(
        "FORBIDDEN"
      );
      expect(prisma.lecturer.findUniqueOrThrow).not.toHaveBeenCalled();
    });
  });

  describe("resetLecturerPassword", () => {
    it("refuses to reset a password for a lecturer with no account", async () => {
      vi.mocked(prisma.lecturer.findUniqueOrThrow).mockResolvedValue({
        id: "lect-1",
        userId: null,
      } as never);

      await expect(resetLecturerPassword("lect-1")).rejects.toThrow(
        "NO_ACCOUNT"
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("resets the password and clears any lockout for an existing account", async () => {
      vi.mocked(prisma.lecturer.findUniqueOrThrow).mockResolvedValue({
        id: "lect-1",
        userId: "existing-user",
        staffNo: "L001",
      } as never);

      const result = await resetLecturerPassword("lect-1");

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
