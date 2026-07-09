import { prisma } from "@/lib/db";
import { RolesClient } from "./roles-client";

export async function RolesPanel() {
  const [roles, permissions] = await Promise.all([
    prisma.role.findMany({
      include: {
        rolePermissions: { include: { permission: true } },
        _count: { select: { userRoles: true } },
      },
      orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    }),
    prisma.permission.findMany({ orderBy: [{ category: "asc" }, { key: "asc" }] }),
  ]);

  return <RolesClient roles={roles} permissions={permissions} />;
}
