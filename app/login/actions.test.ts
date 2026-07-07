import { describe, it, expect, vi, beforeEach } from "vitest";
import argon2 from "argon2";

const mockUser = {
  id: "user-1",
  username: "0615844908",
  email: "student@example.com",
  passwordHash: "hashed",
  isActive: true,
  deletedAt: null,
  lockedUntil: null,
  failedLogins: 0,
  mustChangePw: false,
};

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(async (ops) => ops),
    session: { create: vi.fn() },
  },
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: vi.fn() })),
  headers: vi.fn(async () => new Map()),
}));

vi.mock("argon2", () => ({
  default: {
    verify: vi.fn(),
    argon2id: 2,
  },
}));

import { prisma } from "@/lib/db";
import { login } from "./actions";

function formDataFor(identifier: string, password: string) {
  const fd = new FormData();
  fd.set("identifier", identifier);
  fd.set("password", password);
  return fd;
}

describe("login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("looks up by username OR email, case-insensitively, without lowercasing a mixed-case student ID", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(mockUser as never);
    vi.mocked(argon2.verify).mockResolvedValue(true);

    await login(undefined, formDataFor("CMS-101", "whatever"));

    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { username: { equals: "CMS-101", mode: "insensitive" } },
          { email: { equals: "CMS-101", mode: "insensitive" } },
        ],
      },
    });
  });

  it("logs in successfully with a username identifier", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(mockUser as never);
    vi.mocked(argon2.verify).mockResolvedValue(true);

    const result = await login(undefined, formDataFor("0615844908", "pw"));

    expect(result).toEqual({ success: true, mustChangePassword: false });
  });

  it("logs in successfully with an email identifier", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(mockUser as never);
    vi.mocked(argon2.verify).mockResolvedValue(true);

    const result = await login(
      undefined,
      formDataFor("student@example.com", "pw")
    );

    expect(result).toEqual({ success: true, mustChangePassword: false });
  });

  it("returns a generic error when no user matches either field", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);

    const result = await login(undefined, formDataFor("nobody", "pw"));

    expect(result).toEqual({
      success: false,
      error: "Invalid username/email or password.",
    });
  });

  it("returns a generic error for a wrong password without leaking which field matched", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(mockUser as never);
    vi.mocked(argon2.verify).mockResolvedValue(false);

    const result = await login(undefined, formDataFor("0615844908", "wrong"));

    expect(result).toEqual({
      success: false,
      error: "Invalid username/email or password.",
    });
  });
});
