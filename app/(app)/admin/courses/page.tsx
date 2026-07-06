import { prisma } from "@/lib/db";
import { CoursesClient } from "./courses-client";

export default async function CoursesPage() {
  const courses = await prisma.course.findMany({
    orderBy: { name: "asc" },
  });

  return <CoursesClient courses={courses} />;
}
