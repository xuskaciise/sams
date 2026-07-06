import { describe, it, expect, vi, beforeEach } from "vitest";
import argon2 from "argon2";

const mockUser = {
  id: "user-1",
  passwordHash: "hashed-temp-password",
};

vi.mock("@/lib/auth", () => ({
  getCurrentUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

vi.mock("argon2", () => ({
  default: {
    verify: vi.fn(),
    hash: vi.fn(),
    argon2id: 2,
  },
}));

import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { redirect } from "next/navigation";
import { changePassword } from "./actions";

describe("changePassword", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCurrentUser).mockResolvedValue(mockUser as never);
  });

  it("rejects passwords shorter than 8 characters", async () => {
    const result = await changePassword({
      newPassword: "short1",
      confirmPassword: "short1",
    });

    expect(result).toEqual({
      success: false,
      error: "Please check the form and try again.",
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects mismatched confirmation", async () => {
    const result = await changePassword({
      newPassword: "longenough1",
      confirmPassword: "different1",
    });

    expect(result).toEqual({
      success: false,
      error: "Please check the form and try again.",
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects a new password equal to the current password", async () => {
    vi.mocked(argon2.verify).mockResolvedValue(true);

    const result = await changePassword({
      newPassword: "sameAsCurrent1",
      confirmPassword: "sameAsCurrent1",
    });

    expect(result).toEqual({
      success: false,
      error: "New password must be different from your current password.",
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("updates the password, clears mustChangePw, audits, and redirects on success", async () => {
    vi.mocked(argon2.verify).mockResolvedValue(false);
    vi.mocked(argon2.hash).mockResolvedValue("new-hashed-password" as never);

    await expect(
      changePassword({
        newPassword: "brandNewPassword1",
        confirmPassword: "brandNewPassword1",
      })
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { passwordHash: "new-hashed-password", mustChangePw: false },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PASSWORD_CHANGED",
        entity: "User",
        entityId: "user-1",
      })
    );
    expect(redirect).toHaveBeenCalledWith("/");
  });

  it("throws UNAUTHENTICATED when there is no current session", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    await expect(
      changePassword({
        newPassword: "brandNewPassword1",
        confirmPassword: "brandNewPassword1",
      })
    ).rejects.toThrow("UNAUTHENTICATED");
  });
});
