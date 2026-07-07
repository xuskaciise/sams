import { prisma } from "@/lib/db";
import { StudentAccountsClient } from "./student-accounts-client";

export async function StudentAccountsPanel({ classId }: { classId?: string }) {
  const classes = await prisma.class.findMany({
    where: { deletedAt: null },
    orderBy: { name: "asc" },
  });

  const students = classId
    ? await prisma.student.findMany({
        where: { classId },
        include: { user: true },
        orderBy: { fullName: "asc" },
      })
    : [];

  return (
    <StudentAccountsClient
      classes={classes}
      selectedClassId={classId ?? ""}
      students={students}
    />
  );
}
