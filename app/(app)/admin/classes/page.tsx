import { prisma } from "@/lib/db";
import { ClassesClient } from "./classes-client";

export default async function ClassesPage() {
  const [classes, programs] = await Promise.all([
    prisma.class.findMany({
      include: { program: true },
      orderBy: { name: "asc" },
    }),
    prisma.program.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    }),
  ]);

  return <ClassesClient classes={classes} programs={programs} />;
}
