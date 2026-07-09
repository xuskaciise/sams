import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const { tx } = vi.hoisted(() => ({
  tx: {
    role: { update: vi.fn(), delete: vi.fn() },
    rolePermission: { deleteMany: vi.fn(), createMany: vi.fn() },
    userRole: { deleteMany: vi.fn(), createMany: vi.fn() },
    userPermissionOverride: { deleteMany: vi.fn(), createMany: vi.fn() },
    // assertNoUserManageLockout reads these INSIDE the transaction
    user: { findFirst: vi.fn(), count: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    role: {
      findUniqueOrThrow: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    permission: { findMany: vi.fn() },
    user: { findUniqueOrThrow: vi.fn() },
    userRole: { findMany: vi.fn() },
    userPermissionOverride: { findMany: vi.fn() },
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  },
}));

import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { updateRole, deleteRole, updateUserAccess } from "./actions";

const mockAdmin = { id: "admin-1" };

function actorStillHoldsUserManage(holds: boolean, othersCount = 1) {
  // First findFirst call inside the guard checks the ACTOR.
  vi.mocked(tx.user.findFirst).mockResolvedValue(
    (holds ? { id: mockAdmin.id } : null) as never
  );
  vi.mocked(tx.user.count).mockResolvedValue(othersCount as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
});

describe("updateRole", () => {
  it("rejects renaming a system role", async () => {
    vi.mocked(prisma.role.findUniqueOrThrow).mockResolvedValue({
      id: "role-admin",
      name: "ADMIN",
      isSystem: true,
      rolePermissions: [],
    } as never);

    await expect(
      updateRole("role-admin", {
        name: "SuperAdmin",
        description: "",
        permissionKeys: [],
      })
    ).rejects.toThrow("SYSTEM_ROLE_NAME_IMMUTABLE");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rolls back a permission edit that would strip the last user-manager", async () => {
    vi.mocked(prisma.role.findUniqueOrThrow).mockResolvedValue({
      id: "role-admin",
      name: "ADMIN",
      isSystem: true,
      rolePermissions: [{ permission: { key: "user.manage" } }],
    } as never);
    vi.mocked(prisma.permission.findMany).mockResolvedValue([] as never);
    // Actor no longer holds user.manage after the change.
    actorStillHoldsUserManage(false);

    await expect(
      updateRole("role-admin", {
        name: "ADMIN",
        description: "",
        permissionKeys: [],
      })
    ).rejects.toThrow("SELF_LOCKOUT");
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("deleteRole", () => {
  it("refuses to delete a system role", async () => {
    vi.mocked(prisma.role.findUniqueOrThrow).mockResolvedValue({
      id: "role-student",
      name: "STUDENT",
      isSystem: true,
      rolePermissions: [],
      _count: { userRoles: 7 },
    } as never);

    await expect(deleteRole("role-student")).rejects.toThrow(
      "SYSTEM_ROLE_NOT_DELETABLE"
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("deletes a custom role when no lockout results", async () => {
    vi.mocked(prisma.role.findUniqueOrThrow).mockResolvedValue({
      id: "role-custom",
      name: "Viewer",
      isSystem: false,
      rolePermissions: [{ permission: { key: "audit.view" } }],
      _count: { userRoles: 2 },
    } as never);
    actorStillHoldsUserManage(true);

    await deleteRole("role-custom");
    expect(tx.role.delete).toHaveBeenCalledWith({
      where: { id: "role-custom" },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ROLE_DELETED" })
    );
  });
});

describe("updateUserAccess", () => {
  beforeEach(() => {
    vi.mocked(prisma.user.findUniqueOrThrow).mockResolvedValue({
      id: "target-1",
      userRoles: [{ role: { name: "LECTURER" } }],
      permissionOverrides: [],
    } as never);
    vi.mocked(prisma.role.findUnique).mockResolvedValue({
      id: "role-student",
      name: "STUDENT",
    } as never);
    vi.mocked(prisma.userRole.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.userPermissionOverride.findMany).mockResolvedValue(
      [] as never
    );
  });

  it("blocks removing your own user.manage (SELF_LOCKOUT) and rolls back", async () => {
    actorStillHoldsUserManage(false);

    await expect(
      updateUserAccess("admin-1", { roleIds: [], overrides: [] })
    ).rejects.toThrow("SELF_LOCKOUT");
    expect(audit).not.toHaveBeenCalled();
  });

  it("blocks stripping the LAST holder of user.manage", async () => {
    // Actor keeps user.manage, but no active user holds it any more —
    // e.g. a DENY override applied to the only other manager.
    actorStillHoldsUserManage(true, 0);

    await expect(
      updateUserAccess("target-1", { roleIds: [], overrides: [] })
    ).rejects.toThrow("LAST_USER_MANAGER");
  });

  it("never assigns the STUDENT role through this dialog", async () => {
    await expect(
      updateUserAccess("target-1", {
        roleIds: ["role-student"],
        overrides: [],
      })
    ).rejects.toThrow("INVALID_ROLE");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("replaces roles and overrides in one transaction and audits old->new", async () => {
    actorStillHoldsUserManage(true);

    await updateUserAccess("target-1", {
      roleIds: ["role-lecturer", "role-dean"],
      overrides: [{ permissionId: "perm-1", effect: "DENY" }],
    });

    expect(tx.userRole.deleteMany).toHaveBeenCalledWith({
      where: { userId: "target-1" },
    });
    expect(tx.userRole.createMany).toHaveBeenCalledWith({
      data: [
        { userId: "target-1", roleId: "role-lecturer" },
        { userId: "target-1", roleId: "role-dean" },
      ],
    });
    expect(tx.userPermissionOverride.createMany).toHaveBeenCalledWith({
      data: [
        { userId: "target-1", permissionId: "perm-1", effect: "DENY" },
      ],
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "USER_ACCESS_UPDATED",
        entityId: "target-1",
        oldValue: expect.objectContaining({ roles: ["LECTURER"] }),
      })
    );
  });
});
