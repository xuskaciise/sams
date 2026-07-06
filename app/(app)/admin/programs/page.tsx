import { prisma } from "@/lib/db";
import { ProgramsClient } from "./programs-client";

export default async function ProgramsPage() {
  const [programs, departments] = await Promise.all([
    prisma.program.findMany({
      include: { department: true },
      orderBy: { name: "asc" },
    }),
    prisma.department.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    }),
  ]);

  return <ProgramsClient programs={programs} departments={departments} />;
}
