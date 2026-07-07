import { prisma } from "@/lib/db";
import { StudentsClient } from "./students-client";

export default async function StudentsPage() {
  const [students, classes] = await Promise.all([
    prisma.student.findMany({
      include: { class: true, user: true },
      orderBy: { fullName: "asc" },
    }),
    prisma.class.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    }),
  ]);

  return <StudentsClient students={students} classes={classes} />;
}
