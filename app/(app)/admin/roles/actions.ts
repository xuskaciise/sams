"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import {
  assertNoUserManageLockout,
  assertNoRolesManageLockout,
} from "@/lib/access-guards";
import {
  invalidateAllPermissions,
  invalidateUserPermissions,
} from "@/lib/permission-cache";
import { audit } from "@/lib/audit";
import {
  roleFormSchema,
  type RoleFormInput,
  userAccessSchema,
  type UserAccessInput,
} from "./schema";

const HUB_PATH = "/admin/users";

async function resolvePermissionIds(keys: string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const permissions = await prisma.permission.findMany({
    where: { key: { in: keys } },
  });
  if (permissions.length !== new Set(keys).size) {
    throw new Error("UNKNOWN_PERMISSION");
  }
  return permissions.map((p) => p.id);
}

export async function createRole(input: RoleFormInput) {
  const admin = await requirePermission("roles.manage");
  const data = roleFormSchema.parse(input);
  const permissionIds = await resolvePermissionIds(data.permissionKeys);

  const role = await prisma.$transaction(async (tx) => {
    const created = await tx.role.create({
      data: {
        name: data.name,
        description: data.description || null,
        isSystem: false,
      },
    });
    if (permissionIds.length > 0) {
      await tx.rolePermission.createMany({
        data: permissionIds.map((permissionId) => ({
          roleId: created.id,
          permissionId,
        })),
      });
    }
    return created;
  });

  await audit({
    userId: admin.id,
    action: "ROLE_CREATED",
    entity: "Role",
    entityId: role.id,
    newValue: { name: data.name, permissions: data.permissionKeys },
  });

  revalidatePath(HUB_PATH);
}

export async function updateRole(id: string, input: RoleFormInput) {
  const admin = await requirePermission("roles.manage");
  const data = roleFormSchema.parse(input);

  const existing = await prisma.role.findUniqueOrThrow({
    where: { id },
    include: { rolePermissions: { include: { permission: true } } },
  });
  // System roles keep their name forever; their grants are editable.
  if (existing.isSystem && existing.name !== data.name) {
    throw new Error("SYSTEM_ROLE_NAME_IMMUTABLE");
  }

  const permissionIds = await resolvePermissionIds(data.permissionKeys);
  const oldKeys = existing.rolePermissions.map((rp) => rp.permission.key);

  await prisma.$transaction(async (tx) => {
    await tx.role.update({
      where: { id },
      data: { name: data.name, description: data.description || null },
    });
    await tx.rolePermission.deleteMany({ where: { roleId: id } });
    if (permissionIds.length > 0) {
      await tx.rolePermission.createMany({
        data: permissionIds.map((permissionId) => ({
          roleId: id,
          permissionId,
        })),
      });
    }
    // Removing user.manage/roles.manage from a role must never lock the
    // actor out or leave nobody able to manage users/roles — checked
    // AFTER the change, so a violation rolls the whole thing back.
    await assertNoUserManageLockout(admin.id, tx);
    await assertNoRolesManageLockout(admin.id, tx);
  });
  invalidateAllPermissions();

  await audit({
    userId: admin.id,
    action: "ROLE_UPDATED",
    entity: "Role",
    entityId: id,
    oldValue: { name: existing.name, permissions: oldKeys },
    newValue: { name: data.name, permissions: data.permissionKeys },
  });

  revalidatePath(HUB_PATH);
}

export async function deleteRole(id: string) {
  const admin = await requirePermission("roles.manage");

  const existing = await prisma.role.findUniqueOrThrow({
    where: { id },
    include: {
      rolePermissions: { include: { permission: true } },
      _count: { select: { userRoles: true } },
    },
  });
  if (existing.isSystem) {
    throw new Error("SYSTEM_ROLE_NOT_DELETABLE");
  }

  await prisma.$transaction(async (tx) => {
    // Cascade removes user_roles rows — holders simply lose this role.
    await tx.role.delete({ where: { id } });
    await assertNoUserManageLockout(admin.id, tx);
    await assertNoRolesManageLockout(admin.id, tx);
  });
  invalidateAllPermissions();

  await audit({
    userId: admin.id,
    action: "ROLE_DELETED",
    entity: "Role",
    entityId: id,
    oldValue: {
      name: existing.name,
      permissions: existing.rolePermissions.map((rp) => rp.permission.key),
      holders: existing._count.userRoles,
    },
  });

  revalidatePath(HUB_PATH);
}

export async function updateUserAccess(userId: string, input: UserAccessInput) {
  const admin = await requirePermission("roles.manage");
  const data = userAccessSchema.parse(input);

  const target = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: {
      userRoles: { include: { role: true } },
      permissionOverrides: { include: { permission: true } },
    },
  });

  // STUDENT membership is managed exclusively through Student
  // Registration / Student Accounts, never through this dialog.
  const studentRole = await prisma.role.findUnique({
    where: { name: "STUDENT" },
  });
  if (studentRole && data.roleIds.includes(studentRole.id)) {
    throw new Error("INVALID_ROLE");
  }

  const oldValue = {
    roles: target.userRoles.map((ur) => ur.role.name),
    overrides: target.permissionOverrides.map((o) => ({
      permission: o.permission.key,
      effect: o.effect,
    })),
  };

  await prisma.$transaction(async (tx) => {
    await tx.userRole.deleteMany({ where: { userId } });
    if (data.roleIds.length > 0) {
      await tx.userRole.createMany({
        data: data.roleIds.map((roleId) => ({ userId, roleId })),
      });
    }
    await tx.userPermissionOverride.deleteMany({ where: { userId } });
    if (data.overrides.length > 0) {
      await tx.userPermissionOverride.createMany({
        data: data.overrides.map((o) => ({
          userId,
          permissionId: o.permissionId,
          effect: o.effect,
        })),
      });
    }
    // Covers both lockout rules for user.manage and roles.manage: the
    // actor must still hold each (you cannot remove your own), and at
    // least one active user must still hold each (you cannot strip the
    // last holder).
    await assertNoUserManageLockout(admin.id, tx);
    await assertNoRolesManageLockout(admin.id, tx);
  });
  invalidateUserPermissions(userId);

  const [newRoles, newOverrides] = await Promise.all([
    prisma.userRole.findMany({
      where: { userId },
      include: { role: true },
    }),
    prisma.userPermissionOverride.findMany({
      where: { userId },
      include: { permission: true },
    }),
  ]);

  await audit({
    userId: admin.id,
    action: "USER_ACCESS_UPDATED",
    entity: "User",
    entityId: userId,
    oldValue,
    newValue: {
      roles: newRoles.map((ur) => ur.role.name),
      overrides: newOverrides.map((o) => ({
        permission: o.permission.key,
        effect: o.effect,
      })),
    },
  });

  revalidatePath(HUB_PATH);
}
