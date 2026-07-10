"use server";

import { randomBytes } from "crypto";
import argon2 from "argon2";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import {
  userEffectivelyHolds,
  countEffectiveHolders,
} from "@/lib/access-guards";
import { invalidateUserPermissions } from "@/lib/permission-cache";
import { audit } from "@/lib/audit";
import { userFormSchema, type UserFormInput } from "./schema";

function generateTempPassword(): string {
  return randomBytes(9).toString("base64url");
}

export async function createUser(input: UserFormInput) {
  const admin = await requirePermission("user.manage");
  const data = userFormSchema.parse(input);

  // Role is a name from the roles table now. STUDENT accounts are
  // created exclusively via Student Accounts, never here.
  const role = await prisma.role.findUnique({ where: { name: data.role } });
  if (!role || role.name === "STUDENT") {
    throw new Error("INVALID_ROLE");
  }

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
        passwordHash,
      },
    });

    await tx.userRole.create({
      data: { userId: created.id, roleId: role.id },
    });

    if (role.name === "LECTURER") {
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
    newValue: { email: user.email, role: role.name },
  });

  revalidatePath("/admin/users");
  return { tempPassword };
}

export async function updateUser(id: string, input: UserFormInput) {
  const admin = await requirePermission("user.manage");
  const data = userFormSchema.parse(input);

  // Roles are changed via the Roles & Permissions per-user dialog, never
  // through this form — same intent as the old ROLE_IMMUTABLE rule.
  const existing = await prisma.user.findUniqueOrThrow({
    where: { id },
    include: { userRoles: { include: { role: true } } },
  });
  const roleNames = existing.userRoles.map((ur) => ur.role.name);
  if (!roleNames.includes(data.role)) {
    throw new Error("ROLE_IMMUTABLE");
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id },
      data: { email: data.email, username: data.email, fullName: data.fullName },
    });

    if (roleNames.includes("LECTURER") && data.staffNo?.trim()) {
      await tx.lecturer.update({
        where: { userId: id },
        data: { staffNo: data.staffNo, title: data.title || null },
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
  const admin = await requirePermission("user.manage");
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
  const admin = await requirePermission("user.delete");
  if (id === admin.id) {
    throw new Error("CANNOT_DEACTIVATE_SELF");
  }

  // Never deactivate the last user who can manage users.
  if (
    (await userEffectivelyHolds(id, "user.manage")) &&
    (await countEffectiveHolders("user.manage", [id])) === 0
  ) {
    throw new Error("LAST_USER_MANAGER");
  }
  // Never deactivate the last user who can manage roles — same lockout
  // shape, otherwise nobody could ever reach the Roles & Permissions UI
  // to fix it afterward.
  if (
    (await userEffectivelyHolds(id, "roles.manage")) &&
    (await countEffectiveHolders("roles.manage", [id])) === 0
  ) {
    throw new Error("LAST_ROLES_MANAGER");
  }

  await prisma.user.update({
    where: { id },
    data: { deletedAt: new Date(), isActive: false },
  });
  invalidateUserPermissions(id);

  await audit({
    userId: admin.id,
    action: "USER_DEACTIVATED",
    entity: "User",
    entityId: id,
  });

  revalidatePath("/admin/users");
}

export async function reactivateUser(id: string) {
  const admin = await requirePermission("user.delete");

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
