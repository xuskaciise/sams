import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAdmin = { id: "admin-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    role: { findUnique: vi.fn() },
    userRole: { create: vi.fn() },
    $transaction: vi.fn(async (fn) => {
      if (typeof fn === "function") {
        return fn({
          user: { create: vi.fn().mockResolvedValue({ id: "new-user-1", email: "new@example.com" }) },
          userRole: { create: vi.fn() },
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
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { resetUserPassword, deactivateUser, createUser, updateUser } from "./actions";

const validInput = {
  role: "DEAN",
  email: "new@example.com",
  fullName: "New Dean",
};

describe("createUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.role.findUnique).mockResolvedValue({
      id: "role-dean",
      name: "DEAN",
    } as never);
  });

  it("rejects STUDENT — created exclusively via Student Accounts", async () => {
    vi.mocked(prisma.role.findUnique).mockResolvedValue({
      id: "role-student",
      name: "STUDENT",
    } as never);

    await expect(
      createUser({ ...validInput, role: "STUDENT" })
    ).rejects.toThrow("INVALID_ROLE");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // The actual point of this refactor: lecturer accounts are created
  // exclusively via Lecturer Registration + Lecturer Accounts now, never
  // through the plain Users "Add user" form (which has no way to also
  // create the required Lecturer profile row, and would leave a
  // "ghost" LECTURER user with no staffNo/phoneNumber/Lecturer profile
  // if it tried).
  it("rejects LECTURER — created exclusively via Lecturer Registration / Lecturer Accounts", async () => {
    vi.mocked(prisma.role.findUnique).mockResolvedValue({
      id: "role-lecturer",
      name: "LECTURER",
    } as never);

    await expect(
      createUser({ ...validInput, role: "LECTURER" })
    ).rejects.toThrow("INVALID_ROLE");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("creates an ADMIN/DEAN/custom-role account normally", async () => {
    const result = await createUser(validInput);

    expect(result.tempPassword).toBeTruthy();
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});

describe("updateUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
  });

  // The real risk this guards against: a LECTURER account generated via
  // Lecturer Accounts has username = phone number and email = null.
  // Submitting this form (which always carries a required email field)
  // would silently overwrite that username with the typed email,
  // breaking the lecturer's login — so editing a LECTURER here is
  // rejected outright, before any write.
  it("rejects editing an existing LECTURER account", async () => {
    vi.mocked(prisma.user.findUniqueOrThrow).mockResolvedValue({
      id: "lecturer-user-1",
      userRoles: [{ role: { name: "LECTURER" } }],
    } as never);

    await expect(
      updateUser("lecturer-user-1", { ...validInput, role: "LECTURER" })
    ).rejects.toThrow("LECTURER_NOT_EDITED_HERE");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects changing role away from what the account currently holds", async () => {
    vi.mocked(prisma.user.findUniqueOrThrow).mockResolvedValue({
      id: "dean-user-1",
      userRoles: [{ role: { name: "DEAN" } }],
    } as never);

    await expect(
      updateUser("dean-user-1", { ...validInput, role: "ADMIN" })
    ).rejects.toThrow("ROLE_IMMUTABLE");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("updates an ADMIN/DEAN account's basic fields normally", async () => {
    vi.mocked(prisma.user.findUniqueOrThrow).mockResolvedValue({
      id: "dean-user-1",
      userRoles: [{ role: { name: "DEAN" } }],
    } as never);

    await updateUser("dean-user-1", validInput);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "dean-user-1" },
      data: {
        email: validInput.email,
        username: validInput.email,
        fullName: validInput.fullName,
      },
    });
  });
});

describe("resetUserPassword", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.user.findUniqueOrThrow).mockResolvedValue({
      id: "lecturer-user-1",
      email: "lect@example.com",
    } as never);
  });

  it("blocks an admin from resetting their own password", async () => {
    await expect(resetUserPassword("admin-1")).rejects.toThrow(
      "CANNOT_RESET_SELF"
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("hashes a fresh temp password, forces mustChangePw, and clears any lockout", async () => {
    const result = await resetUserPassword("lecturer-user-1");

    expect(result.tempPassword).toBeTruthy();
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "lecturer-user-1" },
      data: {
        passwordHash: "hashed-temp-password",
        mustChangePw: true,
        failedLogins: 0,
        lockedUntil: null,
        pendingCredential: null,
      },
    });
  });

  it("never returns the plaintext password anywhere but the return value — audit gets only the email", async () => {
    const result = await resetUserPassword("lecturer-user-1");

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "PASSWORD_RESET",
        entity: "User",
        entityId: "lecturer-user-1",
        newValue: { email: "lect@example.com" },
      })
    );
    const auditCall = vi.mocked(audit).mock.calls[0][0];
    expect(JSON.stringify(auditCall)).not.toContain(result.tempPassword);
  });

  it("enforces admin-only access before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(resetUserPassword("lecturer-user-1")).rejects.toThrow(
      "FORBIDDEN"
    );
    expect(prisma.user.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe("deactivateUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    // Target does not hold user.manage → the last-manager guard passes.
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.user.count).mockResolvedValue(1);
  });

  it("blocks deactivating the last user who can manage users", async () => {
    // Target effectively holds user.manage…
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "lecturer-user-1",
    } as never);
    // …and nobody else does.
    vi.mocked(prisma.user.count).mockResolvedValue(0);

    await expect(deactivateUser("lecturer-user-1")).rejects.toThrow(
      "LAST_USER_MANAGER"
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("blocks deactivating the last user who can manage roles", async () => {
    // Target does not hold user.manage (first guard skipped)…
    vi.mocked(prisma.user.findFirst)
      .mockResolvedValueOnce(null as never) // user.manage check
      .mockResolvedValueOnce({ id: "lecturer-user-1" } as never); // roles.manage check
    // …but does effectively hold roles.manage, and nobody else does.
    vi.mocked(prisma.user.count).mockResolvedValueOnce(0 as never);

    await expect(deactivateUser("lecturer-user-1")).rejects.toThrow(
      "LAST_ROLES_MANAGER"
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("blocks an admin from deactivating their own account", async () => {
    await expect(deactivateUser("admin-1")).rejects.toThrow(
      "CANNOT_DEACTIVATE_SELF"
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("deactivates a different user", async () => {
    await deactivateUser("lecturer-user-1");

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "lecturer-user-1" },
      data: expect.objectContaining({ isActive: false }),
    });
  });
});
