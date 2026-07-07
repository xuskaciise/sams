import { prisma } from "@/lib/db";
import { ClassPromotionClient } from "./class-promotion-client";

export async function ClassPromotionPanel({
  sourceClassId,
}: {
  sourceClassId?: string;
}) {
  const [classes, activeSemester] = await Promise.all([
    prisma.class.findMany({
      where: { deletedAt: null },
      include: { program: true },
      orderBy: { name: "asc" },
    }),
    prisma.semester.findFirst({ where: { isActive: true } }),
  ]);

  const sourceClass = sourceClassId
    ? classes.find((c) => c.id === sourceClassId) ?? null
    : null;

  const students = sourceClass
    ? await prisma.student.findMany({
        where: { classId: sourceClass.id },
        orderBy: { fullName: "asc" },
      })
    : [];

  const targetClasses = sourceClass
    ? classes.filter(
        (c) => c.programId === sourceClass.programId && c.id !== sourceClass.id
      )
    : [];

  return (
    <ClassPromotionClient
      classes={classes}
      selectedClassId={sourceClassId ?? ""}
      sourceClass={sourceClass}
      students={students}
      targetClasses={targetClasses}
      activeSemester={activeSemester}
    />
  );
}
