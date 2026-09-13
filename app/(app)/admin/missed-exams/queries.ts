import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getUserAccess } from "@/lib/auth";
import {
  getDeanDepartmentIds,
  classDeanWhere,
  missedExamRecordDeanWhere,
} from "@/lib/dean-scope";
import { resolvePageParams } from "@/lib/pagination";

export interface MissedExamScope {
  isDean: boolean;
  departmentIds: string[];
  recordScope: Prisma.MissedExamRecordWhereInput | undefined;
}

// Shared "who may see/register which record, for which classes" scope
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
    return { isDean: false, departmentIds: [], recordScope: undefined };
  }
  const departmentIds = await getDeanDepartmentIds(userId);
  return {
    isDean: true,
    departmentIds,
    recordScope: missedExamRecordDeanWhere(departmentIds),
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

const missedExamRecordInclude = {
  student: { select: { studentNo: true, fullName: true } },
  course: { select: { name: true, code: true } },
  assignment: { include: { class: true } },
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
  activeSemesterId: string | null;
  classLevels: number[];
  unassigned: boolean;
}

// Special Exam Periods are university-wide (never dean-scoped) — the
// picker offers every ACTIVE one regardless of caller role; only WHICH
// classes/students a Dean can register against is scoped, not which
// periods exist. Ordered most-recent-year-first, matching the
// exam-periods list's own ordering.
export async function getActiveExamPeriodOptions(): Promise<ExamPeriodOption[]> {
  const periods = await prisma.specialExamPeriod.findMany({
    where: { isActive: true },
    select: { id: true, name: true, semesterId: true, academicYearId: true },
    orderBy: [
      { academicYear: { startDate: "desc" } },
      { semester: { semesterNumber: "asc" } },
    ],
  });
  return periods;
}

// Distinct Class.currentSemesterNumber levels available to the caller —
// dean-scoped, mirrors the same aggregation idiom Workload Import's own
// semester-level picker uses.
export async function getClassLevelsForScope(
  isDean: boolean,
  departmentIds: string[]
): Promise<number[]> {
  const classes = await prisma.class.findMany({
    where: {
      deletedAt: null,
      currentSemesterNumber: { not: null },
      ...(isDean ? classDeanWhere(departmentIds) : {}),
    },
    select: { currentSemesterNumber: true },
    distinct: ["currentSemesterNumber"],
  });
  return classes
    .map((c) => c.currentSemesterNumber)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
}

export interface ClassOption {
  id: string;
  name: string;
  currentSemesterNumber: number | null;
}

export async function getClassesForLevel(
  level: number,
  isDean: boolean,
  departmentIds: string[]
): Promise<ClassOption[]> {
  const classes = await prisma.class.findMany({
    where: {
      deletedAt: null,
      currentSemesterNumber: level,
      ...(isDean ? classDeanWhere(departmentIds) : {}),
    },
    select: { id: true, name: true, currentSemesterNumber: true },
    orderBy: { name: "asc" },
  });
  return classes;
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
    return {
      records: [],
      total: 0,
      page: 1,
      pageSize: 10,
      periods: [],
      activeSemesterId: null,
      classLevels: [],
      unassigned: true,
    };
  }

  const { page, pageSize, skip, take } = resolvePageParams(searchParams);
  const where = buildMissedExamWhere(
    { q: searchParams.q, examType: searchParams.examType, reasonType: searchParams.reasonType },
    scope.recordScope
  );

  const [{ records, total }, periods, activeSemester, classLevels] = await Promise.all([
    getMissedExamRecords(where, skip, take),
    getActiveExamPeriodOptions(),
    prisma.semester.findFirst({ where: { isActive: true }, select: { id: true } }),
    getClassLevelsForScope(scope.isDean, scope.departmentIds),
  ]);

  return {
    records,
    total,
    page,
    pageSize,
    periods,
    activeSemesterId: activeSemester?.id ?? null,
    classLevels,
    unassigned: false,
  };
}

export interface MissedExamGridRow {
  enrollmentId: string;
  studentId: string;
  studentNo: string;
  studentFullName: string;
  courseId: string;
  courseName: string;
  courseCode: string;
  assignmentId: string;
}

// The ONE place that resolves "which (student, course) pairs in this
// class, for this period's semester, can a missed exam be recorded
// against" — every ACTIVE enrollment for that class+semester, matched to
// its real LecturerCourseAssignment by courseId (classId+semesterId are
// already fixed for the whole grid, so this is a single lookup, not a
// per-student tuple match). Shared by the grid-loading action AND
// recordMissedExamsBulk's own server-side re-validation, so a submitted
// row can never refer to a course the student isn't actually enrolled
// in. Dean scoping is the CALLER's job (the classId itself must already
// be verified in-scope before this runs) — this function trusts classId
// as given.
export async function getMissedExamGridRows(
  classId: string,
  semesterId: string
): Promise<MissedExamGridRow[]> {
  const [enrollments, assignments] = await Promise.all([
    prisma.studentCourseEnrollment.findMany({
      where: { classId, semesterId, status: "ACTIVE" },
      include: {
        student: { select: { id: true, studentNo: true, fullName: true } },
        course: { select: { id: true, name: true, code: true } },
      },
      orderBy: [{ student: { fullName: "asc" } }],
    }),
    prisma.lecturerCourseAssignment.findMany({
      where: { classId, semesterId },
      select: { id: true, courseId: true },
    }),
  ]);
  if (enrollments.length === 0) return [];

  const assignmentByCourse = new Map(assignments.map((a) => [a.courseId, a.id]));

  const rows: MissedExamGridRow[] = [];
  for (const e of enrollments) {
    const assignmentId = assignmentByCourse.get(e.courseId);
    if (!assignmentId) continue; // no matching assignment — defensively skipped, not shown
    rows.push({
      enrollmentId: e.id,
      studentId: e.student.id,
      studentNo: e.student.studentNo,
      studentFullName: e.student.fullName,
      courseId: e.course.id,
      courseName: e.course.name,
      courseCode: e.course.code,
      assignmentId,
    });
  }
  return rows;
}
