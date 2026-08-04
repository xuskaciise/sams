import { prisma } from "@/lib/db";
import { LecturerAccountsClient, UNASSIGNED_VALUE } from "./lecturer-accounts-client";

export async function LecturerAccountsPanel({
  departmentId,
}: {
  departmentId?: string;
}) {
  const departments = await prisma.department.findMany({
    where: { deletedAt: null },
    orderBy: { name: "asc" },
  });

  const lecturers = departmentId
    ? await prisma.lecturer.findMany({
        where: {
          departmentId: departmentId === UNASSIGNED_VALUE ? null : departmentId,
        },
        include: { user: true },
        orderBy: { fullName: "asc" },
      })
    : [];

  return (
    <LecturerAccountsClient
      departments={departments}
      selectedDepartmentId={departmentId ?? ""}
      lecturers={lecturers}
    />
  );
}
