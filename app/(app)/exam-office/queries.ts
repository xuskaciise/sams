import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolvePageParams } from "@/lib/pagination";

// The EXAM_OFFICE report is deliberately university-wide, NOT scoped by
// dean_departments (unlike admin/missed-exams' own registration list) —
// exam.records.view exists specifically to give the exam office
// cross-faculty visibility. `departmentId` here filters by FACULTY as a
// plain user-picked filter, not a security scope. Filtering by
// `specialExamPeriodId` inherently filters by academic year + semester
// too (a period is 1:1 with a real Semester) — there's no separate raw
// semester dropdown anymore. Course/faculty filters nest through
// `enrollment` now (the record's own course/class), since
// MissedExamRecord no longer carries a direct courseId/assignmentId —
// see the "Special Exam / Missed Exam Registration" business rule in
// CLAUDE.md.
export interface ExamOfficeFilters {
  q?: string;
  specialExamPeriodId?: string;
  departmentId?: string;
  courseId?: string;
  examType?: string;
  reasonType?: string;
}

export function buildExamOfficeWhere(
  filters: ExamOfficeFilters
): Prisma.MissedExamRecordWhereInput {
  const conditions: Prisma.MissedExamRecordWhereInput[] = [];
  if (filters.specialExamPeriodId) {
    conditions.push({ specialExamPeriodId: filters.specialExamPeriodId });
  }
  if (filters.courseId) conditions.push({ enrollment: { courseId: filters.courseId } });
  if (filters.examType) conditions.push({ examType: filters.examType as never });
  if (filters.reasonType) conditions.push({ reasonType: filters.reasonType as never });
  if (filters.departmentId) {
    conditions.push({
      enrollment: { class: { program: { departmentId: filters.departmentId } } },
    });
  }
  if (filters.q) {
    conditions.push({
      OR: [
        { student: { fullName: { contains: filters.q, mode: "insensitive" } } },
        { student: { studentNo: { contains: filters.q, mode: "insensitive" } } },
        { enrollment: { course: { name: { contains: filters.q, mode: "insensitive" } } } },
      ],
    });
  }
  return conditions.length > 0 ? { AND: conditions } : {};
}

const examOfficeRecordInclude = {
  student: { select: { studentNo: true, fullName: true } },
  enrollment: {
    include: {
      course: { select: { name: true, code: true } },
      class: { include: { program: { include: { department: true } } } },
    },
  },
  specialExamPeriod: { include: { academicYear: true, semester: true } },
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
  specialExamPeriodId?: string;
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
  periods: { id: string; name: string }[];
  departments: { id: string; name: string }[];
  courses: { id: string; name: string; code: string }[];
}

// Read-only, university-wide — no dean_departments scoping anywhere in
// this module (see the module comment above). Every filter option list
// is unscoped, mirroring the report's own unscoped record query. Every
// Special Exam Period (active or not) is offered here — the report is a
// historical view, unlike Form 2's registration picker, which only
// offers active ones.
export async function getExamOfficePanelData(
  searchParams: ExamOfficePanelSearchParams
): Promise<ExamOfficePanelData> {
  const { page, pageSize, skip, take } = resolvePageParams(searchParams, 25);
  const where = buildExamOfficeWhere(searchParams);

  const [{ records, total }, periods, departments, courses] = await Promise.all([
    getExamOfficeRecords(where, skip, take),
    prisma.specialExamPeriod.findMany({
      select: { id: true, name: true },
      orderBy: [
        { academicYear: { startDate: "desc" } },
        { semester: { semesterNumber: "asc" } },
      ],
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
    periods,
    departments: departments.map((d) => ({ id: d.id, name: d.name })),
    courses: courses.map((c) => ({ id: c.id, name: c.name, code: c.code })),
  };
}
