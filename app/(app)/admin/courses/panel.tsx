import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolvePageParams } from "@/lib/pagination";
import { CoursesClient } from "./courses-client";

export interface CoursesSearchParams {
  status?: string;
  q?: string;
  page?: string;
  pageSize?: string;
}

export async function CoursesPanel({
  searchParams,
}: {
  searchParams: CoursesSearchParams;
}) {
  const { page, pageSize, skip, take } = resolvePageParams(searchParams);

  const where: Prisma.CourseWhereInput = {
    ...(searchParams.status === "active" ? { deletedAt: null } : {}),
    ...(searchParams.status === "inactive" ? { deletedAt: { not: null } } : {}),
    ...(searchParams.q
      ? {
          OR: [
            { name: { contains: searchParams.q, mode: "insensitive" } },
            { code: { contains: searchParams.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [courses, total] = await Promise.all([
    prisma.course.findMany({
      where,
      orderBy: { name: "asc" },
      skip,
      take,
    }),
    prisma.course.count({ where }),
  ]);

  return (
    <CoursesClient courses={courses} total={total} page={page} pageSize={pageSize} />
  );
}
