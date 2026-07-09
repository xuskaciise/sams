import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";

type Db = PrismaClient | Prisma.TransactionClient;

// Lockout guards for the RBAC admin actions. "Effectively holds" means:
// (granted by any of their roles OR by a GRANT override) AND not removed
// by a DENY override — the same math as lib/auth's getUserAccess, but
// queried fresh (never from the cache) so it can run INSIDE a
// transaction right after changes, throwing to roll them back.

function effectiveHolderWhere(key: string): Prisma.UserWhereInput {
  return {
    isActive: true,
    deletedAt: null,
    NOT: {
      permissionOverrides: {
        some: { effect: "DENY", permission: { key } },
      },
    },
    OR: [
      {
        userRoles: {
          some: { role: { rolePermissions: { some: { permission: { key } } } } },
        },
      },
      {
        permissionOverrides: {
          some: { effect: "GRANT", permission: { key } },
        },
      },
    ],
  };
}

export async function userEffectivelyHolds(
  userId: string,
  key: string,
  db: Db = prisma
): Promise<boolean> {
  const match = await db.user.findFirst({
    where: { id: userId, ...effectiveHolderWhere(key) },
    select: { id: true },
  });
  return match !== null;
}

export async function countEffectiveHolders(
  key: string,
  excludeUserIds: string[] = [],
  db: Db = prisma
): Promise<number> {
  return db.user.count({
    where: {
      id: { notIn: excludeUserIds },
      ...effectiveHolderWhere(key),
    },
  });
}

// Call INSIDE the transaction, AFTER applying role/override/user changes.
// Throws (rolling the transaction back) if the change would leave the
// actor without user.manage (SELF_LOCKOUT) or leave NO active user with
// user.manage at all (LAST_USER_MANAGER).
export async function assertNoUserManageLockout(
  actorId: string,
  db: Db
): Promise<void> {
  if (!(await userEffectivelyHolds(actorId, "user.manage", db))) {
    throw new Error("SELF_LOCKOUT");
  }
  if ((await countEffectiveHolders("user.manage", [], db)) === 0) {
    throw new Error("LAST_USER_MANAGER");
  }
}
