import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolvePageParams } from "@/lib/pagination";

// The EXAM_OFFICE report is deliberately university-wide, NOT scoped by
// dean_departments (unlike admin/missed-exams' own registration list) —
// exam.records.view exists specifically to give the exam office
// cross-faculty visibility. `departmentId` here filters by FACULTY as a
// plain user-picked filter, not a security scope.
export interface ExamOfficeFilters {
  q?: string;
  semesterId?: string;
  departmentId?: string;
  courseId?: string;
  examType?: string;
  reasonType?: string;
}

export function buildExamOfficeWhere(
  filters: ExamOfficeFilters
): Prisma.MissedExamRecordWhereInput {
  const conditions: Prisma.MissedExamRecordWhereInput[] = [];
  if (filters.semesterId) conditions.push({ semesterId: filters.semesterId });
  if (filters.courseId) conditions.push({ courseId: filters.courseId });
  if (filters.examType) conditions.push({ examType: filters.examType as never });
  if (filters.reasonType) conditions.push({ reasonType: filters.reasonType as never });
  if (filters.departmentId) {
    conditions.push({
      assignment: { class: { program: { departmentId: filters.departmentId } } },
    });
  }
  if (filters.q) {
    conditions.push({
      OR: [
        { student: { fullName: { contains: filters.q, mode: "insensitive" } } },
        { student: { studentNo: { contains: filters.q, mode: "insensitive" } } },
        { course: { name: { contains: filters.q, mode: "insensitive" } } },
      ],
    });
  }
  return conditions.length > 0 ? { AND: conditions } : {};
}

const examOfficeRecordInclude = {
  student: { select: { studentNo: true, fullName: true } },
  course: { select: { name: true, code: true } },
  assignment: {
    include: {
      class: { include: { program: { include: { department: true } } } },
    },
  },
  semester: { include: { academicYear: true } },
  recordedBy: { select: { fullName: true } },
} satisfies Prisma.MissedExamRecordInclude;

export type ExamOfficeRecord = Prisma.MissedExamRecordGetPayload<{
  include: typeof examOfficeRecordInclude;
}>;

export async function getExamOfficeRecords(
  where: Prisma.MissedExamRecordWhereInput,
  skip: number,
  take: number
) {
  const [records, total] = await Promise.all([
    prisma.missedExamRecord.findMany({
      where,
      include: examOfficeRecordInclude,
      orderBy: { recordedAt: "desc" },
      skip,
      take,
    }),
    prisma.missedExamRecord.count({ where }),
  ]);
  return { records, total };
}

export interface ExamOfficePanelSearchParams {
  q?: string;
  semesterId?: string;
  departmentId?: string;
  courseId?: string;
  examType?: string;
  reasonType?: string;
  page?: string;
  pageSize?: string;
}

export interface ExamOfficePanelData {
  records: ExamOfficeRecord[];
  total: number;
  page: number;
  pageSize: number;
  semesters: { id: string; name: string; academicYear: { name: string } }[];
  departments: { id: string; name: string }[];
  courses: { id: string; name: string; code: string }[];
}

// Read-only, university-wide — no dean_departments scoping anywhere in
// this module (see the module comment above). Every filter option list
// is unscoped, mirroring the report's own unscoped record query.
export async function getExamOfficePanelData(
  searchParams: ExamOfficePanelSearchParams
): Promise<ExamOfficePanelData> {
  const { page, pageSize, skip, take } = resolvePageParams(searchParams, 25);
  const where = buildExamOfficeWhere(searchParams);

  const [{ records, total }, semesters, departments, courses] = await Promise.all([
    getExamOfficeRecords(where, skip, take),
    prisma.semester.findMany({
      include: { academicYear: true },
      orderBy: [{ academicYear: { startDate: "desc" } }, { semesterNumber: "asc" }],
    }),
    prisma.department.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    }),
    prisma.course.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    }),
  ]);

  return {
    records,
    total,
    page,
    pageSize,
    semesters,
    departments: departments.map((d) => ({ id: d.id, name: d.name })),
    courses: courses.map((c) => ({ id: c.id, name: c.name, code: c.code })),
  };
}
