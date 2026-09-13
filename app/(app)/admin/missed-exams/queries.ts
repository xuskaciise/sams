import type { Prisma, EnrollmentStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getUserAccess } from "@/lib/auth";
import {
  getDeanDepartmentIds,
  studentDeanWhere,
  enrollmentDeanWhere,
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
        { enrollment: { course: { name: { contains: filters.q, mode: "insensitive" } } } },
      ],
    });
  }
  return conditions.length > 0 ? { AND: conditions } : {};
}

const missedExamRecordInclude = {
  student: { select: { studentNo: true, fullName: true } },
  enrollment: {
    include: {
      course: { select: { name: true, code: true } },
      class: { select: { name: true, currentSemesterNumber: true } },
    },
  },
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
// picker offers every ACTIVE one regardless of caller role; only WHICH
// students a Dean can look up is scoped, not which periods exist.
// Ordered most-recent-year-first, matching the exam-periods list's own
// ordering.
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

// The office looks a student up by student_no directly (no Class/
// Semester-Level picker anymore) — dean-scoped via studentDeanWhere,
// same as everywhere else a Dean's student pool is resolved.
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

export interface MissedExamGridRow {
  enrollmentId: string;
  courseId: string;
  courseName: string;
  courseCode: string;
  className: string;
  status: EnrollmentStatus;
  // The batch's cycle level (1..8) this specific enrollment's course
  // belongs to, resolved via ClassCoursePlan(classId, courseId) — NOT
  // Class.currentSemesterNumber, which only reflects the class's level
  // TODAY and would mislabel a student's older enrollments (see the
  // "Special Exam / Missed Exam Registration" business rule in
  // CLAUDE.md). null when no ClassCoursePlan row matches (e.g. a
  // manually-added enrollment never tied to the curriculum template) —
  // grouped under "Unspecified level" client-side, never dropped.
  level: number | null;
}

// The ONE place that resolves "every course this student has EVER been
// enrolled in, across every semester level" — every real
// StudentCourseEnrollment for this student, regardless of status
// (ACTIVE/TRANSFERRED/DROPPED/COMPLETED — a missed exam can legitimately
// need to be registered against an older attempt, so nothing is silently
// excluded by status). A SAME course appearing in two separate
// enrollments (a repeat) surfaces as two separate rows, since each keeps
// its own enrollmentId. Dean-scoped PER-ENROLLMENT (via its own class),
// not just via the student's current class — same "a past enrollment
// under an out-of-scope class stays invisible" rule Dean Reports'
// per-student history already established. Shared by the lookup action
// AND recordMissedExamsBulk's own server-side re-validation, so a
// submitted enrollmentId can never refer to something outside what was
// actually shown.
export async function getStudentEnrollmentRows(
  studentId: string,
  isDean: boolean,
  departmentIds: string[]
): Promise<MissedExamGridRow[]> {
  const enrollments = await prisma.studentCourseEnrollment.findMany({
    where: {
      studentId,
      ...(isDean ? enrollmentDeanWhere(departmentIds) : {}),
    },
    include: {
      course: { select: { id: true, name: true, code: true } },
      class: { select: { id: true, name: true } },
    },
    orderBy: [{ enrolledAt: "asc" }],
  });
  if (enrollments.length === 0) return [];

  const plans = await prisma.classCoursePlan.findMany({
    where: {
      OR: enrollments.map((e) => ({ classId: e.classId, courseId: e.courseId })),
    },
    select: { classId: true, courseId: true, semesterNumber: true },
  });
  const levelByPair = new Map(
    plans.map((p) => [`${p.classId}:${p.courseId}`, p.semesterNumber])
  );

  return enrollments.map((e) => ({
    enrollmentId: e.id,
    courseId: e.course.id,
    courseName: e.course.name,
    courseCode: e.course.code,
    className: e.class.name,
    status: e.status,
    level: levelByPair.get(`${e.classId}:${e.courseId}`) ?? null,
  }));
}
