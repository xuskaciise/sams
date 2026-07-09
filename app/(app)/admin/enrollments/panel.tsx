import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolvePageParams } from "@/lib/pagination";
import { EnrollmentsClient } from "./enrollments-client";

export interface EnrollmentsSearchParams {
  classId?: string;
  courseId?: string;
  status?: string;
  q?: string;
  page?: string;
  pageSize?: string;
}

export async function EnrollmentsPanel({
  searchParams,
}: {
  searchParams: EnrollmentsSearchParams;
}) {
  const { page, pageSize, skip, take } = resolvePageParams(searchParams);

  const where: Prisma.StudentCourseEnrollmentWhereInput = {
    ...(searchParams.classId ? { classId: searchParams.classId } : {}),
    ...(searchParams.courseId ? { courseId: searchParams.courseId } : {}),
    ...(searchParams.status
      ? {
          status: searchParams.status as
            | "ACTIVE"
            | "TRANSFERRED"
            | "DROPPED"
            | "COMPLETED",
        }
      : {}),
    ...(searchParams.q
      ? {
          student: {
            OR: [
              { fullName: { contains: searchParams.q, mode: "insensitive" } },
              { studentNo: { contains: searchParams.q, mode: "insensitive" } },
            ],
          },
        }
      : {}),
  };

  const [enrollments, total, students, courses, semesters, classes] =
    await Promise.all([
      prisma.studentCourseEnrollment.findMany({
        where,
        include: {
          student: true,
          course: true,
          class: true,
          semester: true,
        },
        orderBy: { enrolledAt: "desc" },
        skip,
        take,
      }),
      prisma.studentCourseEnrollment.count({ where }),
      prisma.student.findMany({
        where: { OR: [{ userId: null }, { user: { deletedAt: null } }] },
        orderBy: { fullName: "asc" },
      }),
      prisma.course.findMany({
        where: { deletedAt: null },
        orderBy: { name: "asc" },
      }),
      prisma.semester.findMany({
        where: { isClosed: false },
        orderBy: { startDate: "desc" },
      }),
      prisma.class.findMany({
        where: { deletedAt: null },
        orderBy: { name: "asc" },
      }),
    ]);

  return (
    <EnrollmentsClient
      enrollments={enrollments}
      students={students}
      courses={courses}
      semesters={semesters}
      classes={classes}
      total={total}
      page={page}
      pageSize={pageSize}
    />
  );
}
