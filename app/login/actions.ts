"use server";

import { randomBytes } from "crypto";
import { cookies, headers } from "next/headers";
import argon2 from "argon2";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { hashSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { audit } from "@/lib/audit";

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export type LoginResult =
  | { success: true; mustChangePassword: boolean }
  | { success: false; error: string };

const GENERIC_ERROR = "Invalid email or password.";

export async function login(
  _prevState: LoginResult | undefined,
  formData: FormData,
): Promise<LoginResult> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { success: false, error: GENERIC_ERROR };
  }
  const { email, password } = parsed.data;

  const headerList = await headers();
  const ipAddress =
    headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = headerList.get("user-agent") ?? null;

  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || user.deletedAt || !user.isActive) {
    await audit({
      action: "LOGIN_FAILURE",
      entity: "User",
      entityId: user?.id ?? null,
      ipAddress,
      newValue: { email },
    });
    return { success: false, error: GENERIC_ERROR };
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await audit({
      userId: user.id,
      action: "LOGIN_FAILURE",
      entity: "User",
      entityId: user.id,
      ipAddress,
      newValue: { reason: "locked" },
    });
    return {
      success: false,
      error: "Account locked due to too many failed attempts. Try again later.",
    };
  }

  const passwordValid = await argon2.verify(user.passwordHash, password);

  if (!passwordValid) {
    const failedLogins = user.failedLogins + 1;
    const lockedUntil =
      failedLogins >= MAX_FAILED_ATTEMPTS
        ? new Date(Date.now() + LOCK_DURATION_MS)
        : null;

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLogins, lockedUntil },
    });
    await audit({
      userId: user.id,
      action: "LOGIN_FAILURE",
      entity: "User",
      entityId: user.id,
      ipAddress,
      newValue: { failedLogins },
    });
    return { success: false, error: GENERIC_ERROR };
  }

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { failedLogins: 0, lockedUntil: null },
    }),
    prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: hashSessionToken(token),
        expiresAt,
        ipAddress,
        userAgent,
      },
    }),
  ]);

  await audit({
    userId: user.id,
    action: "LOGIN_SUCCESS",
    entity: "User",
    entityId: user.id,
    ipAddress,
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    expires: expiresAt,
    path: "/",
  });

  return { success: true, mustChangePassword: user.mustChangePw };
}
