import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolvePageParams } from "@/lib/pagination";
import { LecturersClient } from "./lecturers-client";

export interface LecturersSearchParams {
  departmentId?: string;
  q?: string;
  page?: string;
  pageSize?: string;
}

export async function LecturersPanel({
  searchParams,
}: {
  searchParams: LecturersSearchParams;
}) {
  const { page, pageSize, skip, take } = resolvePageParams(searchParams);

  const where: Prisma.LecturerWhereInput = {
    ...(searchParams.departmentId ? { departmentId: searchParams.departmentId } : {}),
    ...(searchParams.q
      ? {
          OR: [
            { fullName: { contains: searchParams.q, mode: "insensitive" } },
            { staffNo: { contains: searchParams.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [lecturers, total, departments] = await Promise.all([
    prisma.lecturer.findMany({
      where,
      include: { department: true, user: true },
      orderBy: { fullName: "asc" },
      skip,
      take,
    }),
    prisma.lecturer.count({ where }),
    prisma.department.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <LecturersClient
      lecturers={lecturers}
      departments={departments}
      total={total}
      page={page}
      pageSize={pageSize}
    />
  );
}
