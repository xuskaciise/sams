"use server";

import { randomBytes } from "crypto";
import argon2 from "argon2";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { userFormSchema, type UserFormInput } from "./schema";

function generateTempPassword(): string {
  return randomBytes(9).toString("base64url");
}

export async function createUser(input: UserFormInput) {
  const admin = await requireRole("ADMIN");
  const data = userFormSchema.parse(input);

  const tempPassword = generateTempPassword();
  const passwordHash = await argon2.hash(tempPassword, {
    type: argon2.argon2id,
  });

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email: data.email,
        username: data.email,
        fullName: data.fullName,
        role: data.role,
        passwordHash,
      },
    });

    if (data.role === "LECTURER") {
      await tx.lecturer.create({
        data: {
          userId: created.id,
          staffNo: data.staffNo!,
          title: data.title || null,
        },
      });
    }

    return created;
  });

  await audit({
    userId: admin.id,
    action: "USER_CREATED",
    entity: "User",
    entityId: user.id,
    newValue: { email: user.email, role: user.role },
  });

  revalidatePath("/admin/users");
  return { tempPassword };
}

export async function updateUser(id: string, input: UserFormInput) {
  const admin = await requireRole("ADMIN");
  const data = userFormSchema.parse(input);

  const existing = await prisma.user.findUniqueOrThrow({ where: { id } });
  if (existing.role !== data.role) {
    throw new Error("ROLE_IMMUTABLE");
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id },
      data: { email: data.email, username: data.email, fullName: data.fullName },
    });

    if (data.role === "LECTURER") {
      await tx.lecturer.update({
        where: { userId: id },
        data: { staffNo: data.staffNo!, title: data.title || null },
      });
    }
  });

  await audit({
    userId: admin.id,
    action: "USER_UPDATED",
    entity: "User",
    entityId: id,
    newValue: { email: data.email, fullName: data.fullName },
  });

  revalidatePath("/admin/users");
}

export async function resetUserPassword(
  id: string
): Promise<{ tempPassword: string }> {
  const admin = await requireRole("ADMIN");
  if (id === admin.id) {
    throw new Error("CANNOT_RESET_SELF");
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id } });

  const tempPassword = generateTempPassword();
  const passwordHash = await argon2.hash(tempPassword, {
    type: argon2.argon2id,
  });

  await prisma.user.update({
    where: { id },
    data: {
      passwordHash,
      mustChangePw: true,
      failedLogins: 0,
      lockedUntil: null,
    },
  });

  await audit({
    userId: admin.id,
    action: "PASSWORD_RESET",
    entity: "User",
    entityId: id,
    newValue: { email: user.email },
  });

  revalidatePath("/admin/users");
  return { tempPassword };
}

export async function deactivateUser(id: string) {
  const admin = await requireRole("ADMIN");
  if (id === admin.id) {
    throw new Error("CANNOT_DEACTIVATE_SELF");
  }

  await prisma.user.update({
    where: { id },
    data: { deletedAt: new Date(), isActive: false },
  });

  await audit({
    userId: admin.id,
    action: "USER_DEACTIVATED",
    entity: "User",
    entityId: id,
  });

  revalidatePath("/admin/users");
}

export async function reactivateUser(id: string) {
  const admin = await requireRole("ADMIN");

  await prisma.user.update({
    where: { id },
    data: {
      deletedAt: null,
      isActive: true,
      failedLogins: 0,
      lockedUntil: null,
    },
  });

  await audit({
    userId: admin.id,
    action: "USER_REACTIVATED",
    entity: "User",
    entityId: id,
  });

  revalidatePath("/admin/users");
}
