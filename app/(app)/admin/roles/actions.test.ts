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
    deanDepartment: { deleteMany: vi.fn(), createMany: vi.fn() },
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
    department: { count: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  },
}));

import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import {
  updateRole,
  deleteRole,
  updateUserAccess,
  updateDeanDepartments,
} from "./actions";

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

  it("rolls back a permission edit that would strip the last roles-manager", async () => {
    vi.mocked(prisma.role.findUniqueOrThrow).mockResolvedValue({
      id: "role-admin",
      name: "ADMIN",
      isSystem: true,
      rolePermissions: [{ permission: { key: "roles.manage" } }],
    } as never);
    vi.mocked(prisma.permission.findMany).mockResolvedValue([] as never);
    // user.manage guard passes (actor still holds it, not last); the
    // roles.manage guard is the one that trips: actor no longer holds it.
    vi.mocked(tx.user.findFirst)
      .mockResolvedValueOnce({ id: mockAdmin.id } as never) // user.manage
      .mockResolvedValueOnce(null as never); // roles.manage
    vi.mocked(tx.user.count).mockResolvedValue(1 as never);

    await expect(
      updateRole("role-admin", {
        name: "ADMIN",
        description: "",
        permissionKeys: [],
      })
    ).rejects.toThrow("SELF_LOCKOUT_ROLES");
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

  it("blocks stripping the LAST holder of roles.manage", async () => {
    // user.manage guard passes; roles.manage guard is the one that trips —
    // actor still holds it, but nobody else (or now nobody at all) does.
    vi.mocked(tx.user.findFirst).mockResolvedValue({
      id: mockAdmin.id,
    } as never);
    vi.mocked(tx.user.count)
      .mockResolvedValueOnce(1 as never) // user.manage: not last
      .mockResolvedValueOnce(0 as never); // roles.manage: last holder gone

    await expect(
      updateUserAccess("target-1", { roleIds: [], overrides: [] })
    ).rejects.toThrow("LAST_ROLES_MANAGER");
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

describe("updateDeanDepartments", () => {
  beforeEach(() => {
    vi.mocked(prisma.user.findUniqueOrThrow).mockResolvedValue({
      id: "dean-1",
      deanDepartments: [{ department: { name: "Computer Science" } }],
    } as never);
    vi.mocked(prisma.department.count).mockResolvedValue(1 as never);
    vi.mocked(prisma.department.findMany).mockResolvedValue([
      { name: "Engineering" },
    ] as never);
  });

  it("enforces roles.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(
      updateDeanDepartments("dean-1", { departmentIds: ["dept-eng"] })
    ).rejects.toThrow("FORBIDDEN");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects an unknown/deleted department id", async () => {
    vi.mocked(prisma.department.count).mockResolvedValue(0 as never);

    await expect(
      updateDeanDepartments("dean-1", { departmentIds: ["dept-fake"] })
    ).rejects.toThrow("UNKNOWN_DEPARTMENT");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("replaces dean_departments rows in one transaction and audits old->new", async () => {
    await updateDeanDepartments("dean-1", { departmentIds: ["dept-eng"] });

    expect(tx.deanDepartment.deleteMany).toHaveBeenCalledWith({
      where: { userId: "dean-1" },
    });
    expect(tx.deanDepartment.createMany).toHaveBeenCalledWith({
      data: [{ userId: "dean-1", departmentId: "dept-eng" }],
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "DEAN_FACULTIES_CHANGED",
        entity: "User",
        entityId: "dean-1",
        oldValue: { departments: ["Computer Science"] },
        newValue: { departments: ["Engineering"] },
      })
    );
  });

  it("clears every department when saving an empty list, without a createMany call", async () => {
    vi.mocked(prisma.department.findMany).mockResolvedValue([]);

    await updateDeanDepartments("dean-1", { departmentIds: [] });

    expect(tx.deanDepartment.deleteMany).toHaveBeenCalledWith({
      where: { userId: "dean-1" },
    });
    expect(tx.deanDepartment.createMany).not.toHaveBeenCalled();
  });
});
