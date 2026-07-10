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
    },
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
import { resetUserPassword, deactivateUser } from "./actions";

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
