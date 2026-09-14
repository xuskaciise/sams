import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getUserAccess } from "@/lib/auth";
import {
  getDeanDepartmentIds,
  studentDeanWhere,
  missedExamRecordDeanWhere,
} from "@/lib/dean-scope";
import { resolvePageParams } from "@/lib/pagination";

export interface MissedExamScope {
  isDean: boolean;
  departmentIds: string[];
  recordScope: Prisma.MissedExamRecordWhereInput | undefined;
  studentScope: Prisma.StudentWhereInput;
}

// Shared "who may see/register which record, for which students" scope
// resolver — same ownership-check-IS-the-query idiom as every other
// dean-scoped feature (Daily Log, Timetable). A pure ADMIN gets
// everything; a DEAN (including a DEAN+ADMIN multi-role user) always
// gets exactly their own dean_departments scope. Re-derived from the
// caller's ROLE every call, never trusted from which route (/admin or
// /dean) rendered the page.
export async function resolveMissedExamScope(userId: string): Promise<MissedExamScope> {
  const { roleNames } = await getUserAccess(userId);
  const isDean = roleNames.includes("DEAN");
  if (!isDean) {
    return { isDean: false, departmentIds: [], recordScope: undefined, studentScope: {} };
  }
  const departmentIds = await getDeanDepartmentIds(userId);
  return {
    isDean: true,
    departmentIds,
    recordScope: missedExamRecordDeanWhere(departmentIds),
    studentScope: studentDeanWhere(departmentIds),
  };
}

export interface MissedExamFilters {
  q?: string;
  examType?: string;
  reasonType?: string;
}

export function buildMissedExamWhere(
  filters: MissedExamFilters,
  scope?: Prisma.MissedExamRecordWhereInput
): Prisma.MissedExamRecordWhereInput {
  const conditions: Prisma.MissedExamRecordWhereInput[] = [];
  if (scope) conditions.push(scope);
  if (filters.examType) conditions.push({ examType: filters.examType as never });
  if (filters.reasonType) conditions.push({ reasonType: filters.reasonType as never });
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

// Student's CURRENT class is shown for display context — MissedExamRecord
// carries no class of its own (it references studentId + courseId
// directly, not a specific enrollment/class), so this is the best
// available "which class" answer, same convention the Historical
// Enrollments Import already established for Student.classId.
const missedExamRecordInclude = {
  student: {
    select: {
      studentNo: true,
      fullName: true,
      class: { select: { name: true, currentSemesterNumber: true } },
    },
  },
  course: { select: { name: true, code: true } },
  specialExamPeriod: { include: { academicYear: true, semester: true } },
  recordedBy: { select: { fullName: true } },
} satisfies Prisma.MissedExamRecordInclude;

export async function getMissedExamRecords(
  where: Prisma.MissedExamRecordWhereInput,
  skip: number,
  take: number
) {
  const [records, total] = await Promise.all([
    prisma.missedExamRecord.findMany({
      where,
      include: missedExamRecordInclude,
      orderBy: { recordedAt: "desc" },
      skip,
      take,
    }),
    prisma.missedExamRecord.count({ where }),
  ]);
  return { records, total };
}

export interface MissedExamPanelSearchParams {
  q?: string;
  examType?: string;
  reasonType?: string;
  page?: string;
  pageSize?: string;
}

export interface ExamPeriodOption {
  id: string;
  name: string;
  semesterId: string;
  academicYearId: string;
}

export interface MissedExamPanelData {
  records: Awaited<ReturnType<typeof getMissedExamRecords>>["records"];
  total: number;
  page: number;
  pageSize: number;
  periods: ExamPeriodOption[];
  unassigned: boolean;
}

// Special Exam Periods are university-wide (never dean-scoped) — the
// picker offers every OPEN one regardless of caller role; only WHICH
// students a Dean can look up is scoped, not which periods exist. A
// CLOSED period simply isn't offered here — this is what satisfies "the
// period should not even be selectable" (see the Special Exam Period
// business rule in CLAUDE.md); recordMissedExamsBulk ALSO re-checks
// status server-side before writing, since this picker alone isn't a
// security boundary a stale page can't route around. Ordered
// most-recent-year-first, matching the exam-periods list's own ordering.
export async function getActiveExamPeriodOptions(): Promise<ExamPeriodOption[]> {
  const periods = await prisma.specialExamPeriod.findMany({
    where: { status: "OPEN" },
    select: { id: true, name: true, semesterId: true, academicYearId: true },
    orderBy: [
      { academicYear: { startDate: "desc" } },
      { semester: { semesterNumber: "asc" } },
    ],
  });
  return periods;
}

// Re-derives the real scope from the caller's ROLE every call, exactly
// like getDailyLogPanelData — the shared exam.records.manage permission
// alone can't say which faculty a Dean may see/register for. An
// unassigned Dean (zero dean_departments) gets the same "No faculties
// assigned yet" empty-state shape as every other dean-scoped feature.
export async function getMissedExamPanelData(
  userId: string,
  searchParams: MissedExamPanelSearchParams
): Promise<MissedExamPanelData> {
  const scope = await resolveMissedExamScope(userId);
  if (scope.isDean && scope.departmentIds.length === 0) {
    return { records: [], total: 0, page: 1, pageSize: 10, periods: [], unassigned: true };
  }

  const { page, pageSize, skip, take } = resolvePageParams(searchParams);
  const where = buildMissedExamWhere(
    { q: searchParams.q, examType: searchParams.examType, reasonType: searchParams.reasonType },
    scope.recordScope
  );

  const [{ records, total }, periods] = await Promise.all([
    getMissedExamRecords(where, skip, take),
    getActiveExamPeriodOptions(),
  ]);

  return { records, total, page, pageSize, periods, unassigned: false };
}

export interface StudentLookupResult {
  id: string;
  studentNo: string;
  fullName: string;
}

// The office looks a student up by student_no directly — dean-scoped via
// studentDeanWhere, same as everywhere else a Dean's student pool is
// resolved. Whether the student's own enrollment history is complete or
// even exists at all is irrelevant here — Form 2 no longer derives
// anything from it (see getAllCourseOptions below).
export async function findStudentByNo(
  studentNo: string,
  isDean: boolean,
  departmentIds: string[]
): Promise<StudentLookupResult | null> {
  return prisma.student.findFirst({
    where: {
      studentNo: { equals: studentNo, mode: "insensitive" },
      ...(isDean ? studentDeanWhere(departmentIds) : {}),
    },
    select: { id: true, studentNo: true, fullName: true },
  });
}

export interface CourseOption {
  id: string;
  name: string;
  code: string;
}

// ALL active courses in the system, university-wide and completely
// UNSCOPED by the looked-up student — deliberately not filtered by
// enrollment, semester level, or parity (that entire enrollment-derived
// design was replaced; see the "Special Exam / Missed Exam Registration"
// business rule's changelog for the full history). Office staff know
// from paperwork/context which of these actually apply to a given
// student and check them off manually. Soft-deleted courses are excluded
// — this is a picker for NEW registrations going forward, unlike the
// Historical Enrollments Import, which deliberately includes them for
// legitimate backfill of already-past courses.
export async function getAllCourseOptions(): Promise<CourseOption[]> {
  const courses = await prisma.course.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, code: true },
    orderBy: { name: "asc" },
  });
  return courses;
}
