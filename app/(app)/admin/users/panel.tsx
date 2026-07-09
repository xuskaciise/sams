import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { resolvePageParams } from "@/lib/pagination";
import { UsersClient } from "./users-client";

export interface UsersSearchParams {
  role?: string;
  status?: string;
  q?: string;
  page?: string;
  pageSize?: string;
}

export async function UsersPanel({
  searchParams,
}: {
  searchParams: UsersSearchParams;
}) {
  const { page, pageSize, skip, take } = resolvePageParams(searchParams);
  const currentUser = await getCurrentUser();

  // AND-of-ORs — both the staff scope and the search are OR groups, so
  // they must not share the top-level OR key.
  const where: Prisma.UserWhereInput = {
    AND: [
      // This page manages STAFF accounts only: anyone holding a
      // non-STUDENT role, plus users with no role at all (so a
      // misconfigured account is still findable and fixable here).
      searchParams.role
        ? { userRoles: { some: { role: { name: searchParams.role } } } }
        : {
            OR: [
              { userRoles: { some: { role: { name: { not: "STUDENT" } } } } },
              { userRoles: { none: {} } },
            ],
          },
      ...(searchParams.status === "active" ? [{ deletedAt: null }] : []),
      ...(searchParams.status === "inactive"
        ? [{ deletedAt: { not: null } }]
        : []),
      ...(searchParams.q
        ? [
            {
              OR: [
                { fullName: { contains: searchParams.q, mode: "insensitive" as const } },
                { email: { contains: searchParams.q, mode: "insensitive" as const } },
              ],
            },
          ]
        : []),
    ],
  };

  const [users, total, roles, permissions] = await Promise.all([
    prisma.user.findMany({
      where,
      include: {
        lecturerProfile: true,
        userRoles: { include: { role: true } },
        permissionOverrides: true,
      },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    prisma.user.count({ where }),
    prisma.role.findMany({
      where: { name: { not: "STUDENT" } },
      include: { rolePermissions: { include: { permission: true } } },
      orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    }),
    prisma.permission.findMany({
      orderBy: [{ category: "asc" }, { key: "asc" }],
    }),
  ]);

  return (
    <UsersClient
      users={users}
      roles={roles}
      permissions={permissions}
      currentUserId={currentUser!.id}
      total={total}
      page={page}
      pageSize={pageSize}
    />
  );
}
