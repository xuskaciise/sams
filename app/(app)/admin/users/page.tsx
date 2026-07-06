import { prisma } from "@/lib/db";
import { UsersClient } from "./users-client";

export default async function UsersPage() {
  const [users, classes] = await Promise.all([
    prisma.user.findMany({
      include: { lecturerProfile: true, studentProfile: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.class.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    }),
  ]);

  return <UsersClient users={users} classes={classes} />;
}
