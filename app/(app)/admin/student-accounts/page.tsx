import { prisma } from "@/lib/db";
import { StudentAccountsClient } from "./student-accounts-client";

export default async function StudentAccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ classId?: string }>;
}) {
  const { classId } = await searchParams;

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
