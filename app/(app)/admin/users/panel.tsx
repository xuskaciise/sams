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

  const where: Prisma.UserWhereInput = {
    role: searchParams.role
      ? (searchParams.role as "ADMIN" | "DEAN" | "LECTURER")
      : { not: "STUDENT" },
    ...(searchParams.status === "active" ? { deletedAt: null } : {}),
    ...(searchParams.status === "inactive" ? { deletedAt: { not: null } } : {}),
    ...(searchParams.q
      ? {
          OR: [
            { fullName: { contains: searchParams.q, mode: "insensitive" } },
            { email: { contains: searchParams.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      include: { lecturerProfile: true },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    prisma.user.count({ where }),
  ]);

  return (
    <UsersClient
      users={users}
      currentUserId={currentUser!.id}
      total={total}
      page={page}
      pageSize={pageSize}
    />
  );
}
