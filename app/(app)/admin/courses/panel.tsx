import { prisma } from "@/lib/db";
import { CoursesClient } from "./courses-client";

export async function CoursesPanel() {
  const courses = await prisma.course.findMany({
    orderBy: { name: "asc" },
  });

  return <CoursesClient courses={courses} />;
}
