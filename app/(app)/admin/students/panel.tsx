import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolvePageParams } from "@/lib/pagination";
import { StudentsClient } from "./students-client";

export interface StudentsSearchParams {
  classId?: string;
  q?: string;
  page?: string;
  pageSize?: string;
}

export async function StudentsPanel({
  searchParams,
}: {
  searchParams: StudentsSearchParams;
}) {
  const { page, pageSize, skip, take } = resolvePageParams(searchParams);

  const where: Prisma.StudentWhereInput = {
    ...(searchParams.classId ? { classId: searchParams.classId } : {}),
    ...(searchParams.q
      ? {
          OR: [
            { fullName: { contains: searchParams.q, mode: "insensitive" } },
            { studentNo: { contains: searchParams.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [students, total, classes] = await Promise.all([
    prisma.student.findMany({
      where,
      include: { class: true, user: true },
      orderBy: { fullName: "asc" },
      skip,
      take,
    }),
    prisma.student.count({ where }),
    prisma.class.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <StudentsClient
      students={students}
      classes={classes}
      total={total}
      page={page}
      pageSize={pageSize}
    />
  );
}
