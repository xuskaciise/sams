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
    whatsAppSettings: { findUnique: vi.fn() },
    semester: { findFirst: vi.fn() },
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

vi.mock("@/lib/whatsapp-notify", () => ({
  WHATSAPP_SETTINGS_ID: "singleton",
  buildLecturerCredentialsShareUrl: vi
    .fn()
    .mockResolvedValue({ url: "https://wa.me/252611111111?text=hi" }),
}));

// Fake reversible codec: "enc:<plain>" <-> "<plain>".
vi.mock("@/lib/credential-crypto", () => ({
  credentialStoreConfigured: vi.fn(() => true),
  encryptCredential: vi.fn((p: string) => `enc:${p}`),
  decryptCredential: vi.fn((b: string | null | undefined) =>
    typeof b === "string" && b.startsWith("enc:") ? b.slice(4) : null
  ),
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
import { audit } from "@/lib/audit";
import { buildLecturerCredentialsShareUrl as buildShareUrl } from "@/lib/whatsapp-notify";
import {
  generateAccountsForDepartment,
  generateAccountForLecturer,
  resetLecturerPassword,
  shareLecturerCredentials,
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
            // Encrypted temp password stored so it stays re-sendable from
            // the main table later.
            pendingCredential: expect.stringMatching(/^enc:/),
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
          // A fresh temp password is "un-shared" again, and it's the one
          // that's now stored/shareable from the table.
          credentialsLinkOpenedAt: null,
          pendingCredential: expect.stringMatching(/^enc:/),
        }),
      });
    });
  });

  describe("shareLecturerCredentials", () => {
    const activeSemester = {
      name: "Semester 1",
      academicYear: { name: "2026-2027" },
    };
    const lecturerWithAccount = {
      id: "lect-1",
      staffNo: "L001",
      fullName: "Dr. A",
      phoneNumber: "+252611111111",
      user: {
        id: "user-1",
        username: "+252611111111",
        mustChangePw: true,
        credentialsLinkOpenedAt: null,
        pendingCredential: "enc:StoredPass9",
      },
      department: { name: "Faculty of Computing" },
      assignments: [],
    };

    beforeEach(() => {
      vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({
        id: "singleton",
        domainName: "sams.university.edu",
      } as never);
      vi.mocked(prisma.semester.findFirst).mockResolvedValue(activeSemester as never);
      vi.mocked(prisma.lecturer.findUniqueOrThrow).mockResolvedValue(
        lecturerWithAccount as never
      );
      vi.mocked(buildShareUrl).mockResolvedValue({
        url: "https://wa.me/252611111111?text=creds",
      });
    });

    it("enforces user.manage", async () => {
      vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
      await expect(
        shareLecturerCredentials({ lecturerId: "lect-1", tempPassword: "p" })
      ).rejects.toThrow("FORBIDDEN");
    });

    it("refuses when no login domain is configured", async () => {
      vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({
        id: "singleton",
        domainName: null,
      } as never);
      await expect(
        shareLecturerCredentials({ lecturerId: "lect-1", tempPassword: "p" })
      ).rejects.toThrow("DOMAIN_NOT_CONFIGURED");
      expect(buildShareUrl).not.toHaveBeenCalled();
    });

    it("builds the wa.me link, records the link as opened, and audits it — never enqueues a worker row", async () => {
      const res = await shareLecturerCredentials({
        lecturerId: "lect-1",
        tempPassword: "TmpPass123",
      });

      expect(res).toEqual({ status: "opened", url: "https://wa.me/252611111111?text=creds" });
      expect(buildShareUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          phoneNumber: "+252611111111",
          username: "+252611111111",
          tempPassword: "TmpPass123",
          facultyName: "Faculty of Computing",
          academicYear: "2026-2027",
          semesterName: "Semester 1",
          domainName: "sams.university.edu",
        })
      );
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { credentialsLinkOpenedAt: expect.any(Date) },
      });
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "LECTURER_CREDENTIALS_LINK_OPENED",
          entity: "User",
          entityId: "user-1",
        })
      );
    });

    it("uses the decrypted stored credential when the caller supplies no password (persistent table path)", async () => {
      const res = await shareLecturerCredentials({ lecturerId: "lect-1" });

      expect(res.status).toBe("opened");
      expect(buildShareUrl).toHaveBeenCalledWith(
        expect.objectContaining({ tempPassword: "StoredPass9" })
      );
    });

    it("throws NO_STORED_CREDENTIAL when there's neither a supplied nor a decryptable stored password", async () => {
      vi.mocked(prisma.lecturer.findUniqueOrThrow).mockResolvedValue({
        ...lecturerWithAccount,
        user: { ...lecturerWithAccount.user, pendingCredential: null },
      } as never);

      await expect(
        shareLecturerCredentials({ lecturerId: "lect-1" })
      ).rejects.toThrow("NO_STORED_CREDENTIAL");
      expect(buildShareUrl).not.toHaveBeenCalled();
    });

    it("soft-blocks a second share for an already-opened link unless forced", async () => {
      vi.mocked(prisma.lecturer.findUniqueOrThrow).mockResolvedValue({
        ...lecturerWithAccount,
        user: { ...lecturerWithAccount.user, credentialsLinkOpenedAt: new Date() },
      } as never);

      await expect(
        shareLecturerCredentials({ lecturerId: "lect-1", tempPassword: "p" })
      ).rejects.toThrow("ALREADY_OPENED");
      expect(buildShareUrl).not.toHaveBeenCalled();

      const res = await shareLecturerCredentials({
        lecturerId: "lect-1",
        tempPassword: "p",
        force: true,
      });
      expect(res.status).toBe("opened");
      expect(buildShareUrl).toHaveBeenCalledTimes(1);
    });

    it("hard-blocks once the lecturer has changed their password — force does not override", async () => {
      vi.mocked(prisma.lecturer.findUniqueOrThrow).mockResolvedValue({
        ...lecturerWithAccount,
        user: { ...lecturerWithAccount.user, mustChangePw: false, credentialsLinkOpenedAt: new Date() },
      } as never);

      await expect(
        shareLecturerCredentials({ lecturerId: "lect-1", tempPassword: "p", force: true })
      ).rejects.toThrow("PASSWORD_CHANGED");
      expect(buildShareUrl).not.toHaveBeenCalled();
    });

    it("returns no_phone (recording nothing) when there's no number to link to", async () => {
      vi.mocked(buildShareUrl).mockResolvedValue({ url: null });

      const res = await shareLecturerCredentials({
        lecturerId: "lect-1",
        tempPassword: "p",
      });
      expect(res).toEqual({ status: "no_phone" });
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it("falls back to a class's program department when the lecturer has no home faculty", async () => {
      vi.mocked(prisma.lecturer.findUniqueOrThrow).mockResolvedValue({
        ...lecturerWithAccount,
        department: null,
        assignments: [
          { class: { program: { department: { name: "Faculty of Engineering" } } } },
        ],
      } as never);

      await shareLecturerCredentials({ lecturerId: "lect-1", tempPassword: "p" });

      expect(buildShareUrl).toHaveBeenCalledWith(
        expect.objectContaining({ facultyName: "Faculty of Engineering" })
      );
    });
  });
});
