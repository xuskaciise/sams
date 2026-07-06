"use server";

import argon2 from "argon2";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { changePasswordSchema, type ChangePasswordInput } from "./schema";

export type ChangePasswordResult =
  | { success: true }
  | { success: false; error: string };

export async function changePassword(
  input: ChangePasswordInput
): Promise<ChangePasswordResult> {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error("UNAUTHENTICATED");
  }

  const parsed = changePasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Please check the form and try again." };
  }
  const data = parsed.data;

  const sameAsCurrent = await argon2.verify(
    user.passwordHash,
    data.newPassword
  );
  if (sameAsCurrent) {
    return {
      success: false,
      error: "New password must be different from your current password.",
    };
  }

  const passwordHash = await argon2.hash(data.newPassword, {
    type: argon2.argon2id,
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, mustChangePw: false },
  });

  await audit({
    userId: user.id,
    action: "PASSWORD_CHANGED",
    entity: "User",
    entityId: user.id,
  });

  redirect("/");
}
