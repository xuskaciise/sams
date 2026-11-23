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
  periodId?: string;
  examType?: string;
  reasonType?: string;
}

export function buildMissedExamWhere(
  filters: MissedExamFilters,
  scope?: Prisma.MissedExamRecordWhereInput
): Prisma.MissedExamRecordWhereInput {
  const conditions: Prisma.MissedExamRecordWhereInput[] = [];
  if (scope) conditions.push(scope);
  if (filters.periodId) conditions.push({ specialExamPeriodId: filters.periodId });
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
  periodId?: string;
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
  mode: MissedExamPanelMode;
}

// "register": registration form + ONLY the selected period's records.
// "records": the full records list (all periods, with a Period filter).
export type MissedExamPanelMode = "register" | "records";

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

// Every period (open or closed) — the records page's Period filter is a
// historical view, unlike the registration picker above.
export async function getAllExamPeriodOptions(): Promise<ExamPeriodOption[]> {
  return prisma.specialExamPeriod.findMany({
    select: { id: true, name: true, semesterId: true, academicYearId: true },
    orderBy: [
      { academicYear: { startDate: "desc" } },
      { semester: { semesterNumber: "asc" } },
    ],
  });
}

// Re-derives the real scope from the caller's ROLE every call, exactly
// like getDailyLogPanelData — the shared exam.records.manage permission
// alone can't say which faculty a Dean may see/register for. An
// unassigned Dean (zero dean_departments) gets the same "No faculties
// assigned yet" empty-state shape as every other dean-scoped feature.
export async function getMissedExamPanelData(
  userId: string,
  searchParams: MissedExamPanelSearchParams,
  mode: MissedExamPanelMode = "register"
): Promise<MissedExamPanelData> {
  const scope = await resolveMissedExamScope(userId);
  if (scope.isDean && scope.departmentIds.length === 0) {
    return { records: [], total: 0, page: 1, pageSize: 10, periods: [], unassigned: true, mode };
  }

  const { page, pageSize, skip, take } = resolvePageParams(searchParams);
  const periodsPromise =
    mode === "register" ? getActiveExamPeriodOptions() : getAllExamPeriodOptions();

  // Registration page: records are only the selected period's — with no
  // period selected there is nothing to list.
  if (mode === "register" && !searchParams.periodId) {
    const periods = await periodsPromise;
    return { records: [], total: 0, page, pageSize, periods, unassigned: false, mode };
  }

  const where = buildMissedExamWhere(
    {
      q: searchParams.q,
      periodId: searchParams.periodId,
      examType: searchParams.examType,
      reasonType: searchParams.reasonType,
    },
    scope.recordScope
  );

  const [{ records, total }, periods] = await Promise.all([
    getMissedExamRecords(where, skip, take),
    periodsPromise,
  ]);

  return { records, total, page, pageSize, periods, unassigned: false, mode };
}

export interface StudentLookupResult {
  id: string;
  studentNo: string;
  fullName: string;
  className: string | null;
}

// The office looks a student up by student_no directly — dean-scoped via
// studentDeanWhere, same as everywhere else a Dean's student pool is
// resolved. Whether the student's own enrollment history is complete or
// even exists at all is irrelevant here — Form 2 no longer derives
// anything from it (see getStudentSemesterCourses below).
export async function findStudentByNo(
  studentNo: string,
  isDean: boolean,
  departmentIds: string[]
): Promise<StudentLookupResult | null> {
  const row = await prisma.student.findFirst({
    where: {
      studentNo: { equals: studentNo, mode: "insensitive" },
      ...(isDean ? studentDeanWhere(departmentIds) : {}),
    },
    select: { id: true, studentNo: true, fullName: true, class: { select: { name: true } } },
  });
  if (!row) return null;
  return {
    id: row.id,
    studentNo: row.studentNo,
    fullName: row.fullName,
    className: row.class?.name ?? null,
  };
}

export interface CourseOption {
  id: string;
  name: string;
  code: string;
}

// The student's OWN courses for one semester: their non-DROPPED
// StudentCourseEnrollment rows with semesterId = the period's semester
// (deduped by courseId — a course can appear under several statuses),
// minus soft-deleted courses. Used by the lookup AND re-derived by
// recordMissedExamsBulk (never trust the client's list).
export async function getStudentSemesterCourses(
  studentId: string,
  semesterId: string
): Promise<CourseOption[]> {
  const rows = await prisma.studentCourseEnrollment.findMany({
    where: {
      studentId,
      semesterId,
      status: { not: "DROPPED" },
      course: { deletedAt: null },
    },
    select: { course: { select: { id: true, name: true, code: true } } },
  });
  const byId = new Map<string, CourseOption>();
  for (const r of rows) byId.set(r.course.id, r.course);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export type CourseListSource = "enrollments" | "coursePlan" | "allCourses";

export interface StudentCourseList {
  courses: CourseOption[];
  source: CourseListSource;
  // Only set when source === "coursePlan".
  planSemesterNumber: number | null;
}

// The ONE course-list derivation, used by both the lookup and
// recordMissedExamsBulk (never trust the client's list). Fallback order:
//  a) the student's non-DROPPED enrollments for the period's semester;
//  b) the student's CURRENT class's ClassCoursePlan at its
//     currentSemesterNumber (active courses only);
//  c) every active course (staff pick manually).
export async function getCourseListForStudent(
  studentId: string,
  semesterId: string
): Promise<StudentCourseList> {
  const enrolled = await getStudentSemesterCourses(studentId, semesterId);
  if (enrolled.length > 0) {
    return { courses: enrolled, source: "enrollments", planSemesterNumber: null };
  }

  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: { class: { select: { id: true, currentSemesterNumber: true } } },
  });
  const cls = student?.class;
  if (cls && cls.currentSemesterNumber != null) {
    const plan = await prisma.classCoursePlan.findMany({
      where: {
        classId: cls.id,
        semesterNumber: cls.currentSemesterNumber,
        course: { deletedAt: null },
      },
      select: { course: { select: { id: true, name: true, code: true } } },
    });
    if (plan.length > 0) {
      const byId = new Map<string, CourseOption>();
      for (const r of plan) byId.set(r.course.id, r.course);
      return {
        courses: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)),
        source: "coursePlan",
        planSemesterNumber: cls.currentSemesterNumber,
      };
    }
  }

  const all = await prisma.course.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, code: true },
    orderBy: { name: "asc" },
  });
  return { courses: all, source: "allCourses", planSemesterNumber: null };
}

// Courses that already have a record for (student, period).
export async function getRegisteredCourseIds(
  studentId: string,
  specialExamPeriodId: string
): Promise<Set<string>> {
  const rows = await prisma.missedExamRecord.findMany({
    where: { studentId, specialExamPeriodId },
    select: { courseId: true },
  });
  return new Set(rows.map((r) => r.courseId));
}
