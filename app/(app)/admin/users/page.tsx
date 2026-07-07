import { prisma } from "@/lib/db";
import { UsersClient } from "./users-client";

export default async function UsersPage() {
  const users = await prisma.user.findMany({
    where: { role: { not: "STUDENT" } },
    include: { lecturerProfile: true },
    orderBy: { createdAt: "desc" },
  });

  return <UsersClient users={users} />;
}
