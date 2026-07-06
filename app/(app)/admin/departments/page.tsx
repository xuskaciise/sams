import { prisma } from "@/lib/db";
import { DepartmentsClient } from "./departments-client";

export default async function DepartmentsPage() {
  const departments = await prisma.department.findMany({
    orderBy: { name: "asc" },
  });

  return <DepartmentsClient departments={departments} />;
}
