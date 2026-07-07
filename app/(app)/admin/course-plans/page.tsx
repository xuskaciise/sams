import { prisma } from "@/lib/db";
import { CoursePlansClient } from "./course-plans-client";

export default async function CoursePlansPage({
  searchParams,
}: {
  searchParams: Promise<{ classId?: string }>;
}) {
  const { classId } = await searchParams;

  const [classes, courses, plan] = await Promise.all([
    prisma.class.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    }),
    prisma.course.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    }),
    classId
      ? prisma.classCoursePlan.findMany({
          where: { classId },
          include: { course: true },
          orderBy: { course: { name: "asc" } },
        })
      : Promise.resolve([]),
  ]);

  return (
    <CoursePlansClient
      classes={classes}
      courses={courses}
      plan={plan}
      selectedClassId={classId ?? ""}
    />
  );
}
