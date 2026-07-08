import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { UsersClient } from "./users-client";

export default async function UsersPage() {
  const [currentUser, users] = await Promise.all([
    getCurrentUser(),
    prisma.user.findMany({
      where: { role: { not: "STUDENT" } },
      include: { lecturerProfile: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return <UsersClient users={users} currentUserId={currentUser!.id} />;
}
