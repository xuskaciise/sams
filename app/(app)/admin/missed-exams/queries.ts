import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getUserAccess } from "@/lib/auth";
import {
  getDeanDepartmentIds,
  classDeanWhere,
  missedExamRecordDeanWhere,
  studentDeanWhere,
} from "@/lib/dean-scope";
import { resolvePageParams } from "@/lib/pagination";

export interface MissedExamScope {
  isDean: boolean;
  departmentIds: string[];
  recordScope: Prisma.MissedExamRecordWhereInput | undefined;
  studentScope: Prisma.StudentWhereInput;
}

// Shared "who may see/write which record" scope resolver — same
// ownership-check-IS-the-query idiom as every other dean-scoped feature
// (Daily Log, Timetable). A pure ADMIN gets everything; a DEAN (including
// a DEAN+ADMIN multi-role user) always gets exactly their own
// dean_departments scope. Re-derived from the caller's ROLE every call,
// never trusted from which route (/admin or /dean) rendered the page.
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

const missedExamRecordInclude = {
  student: { select: { studentNo: true, fullName: true } },
  course: { select: { name: true, code: true } },
  assignment: { include: { class: true } },
  semester: { include: { academicYear: true } },
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

export interface MissedExamPanelData {
  records: Awaited<ReturnType<typeof getMissedExamRecords>>["records"];
  total: number;
  page: number;
  pageSize: number;
  students: { id: string; studentNo: string; fullName: string }[];
  unassigned: boolean;
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
    return { records: [], total: 0, page: 1, pageSize: 10, students: [], unassigned: true };
  }

  const { page, pageSize, skip, take } = resolvePageParams(searchParams);
  const where = buildMissedExamWhere(
    { q: searchParams.q, examType: searchParams.examType, reasonType: searchParams.reasonType },
    scope.recordScope
  );

  const [{ records, total }, students] = await Promise.all([
    getMissedExamRecords(where, skip, take),
    prisma.student.findMany({
      where: scope.studentScope,
      select: { id: true, studentNo: true, fullName: true },
      orderBy: { fullName: "asc" },
    }),
  ]);

  return { records, total, page, pageSize, students, unassigned: false };
}

export interface StudentExamOption {
  assignmentId: string;
  courseId: string;
  courseName: string;
  courseCode: string;
  className: string;
  semesterId: string;
  semesterName: string;
}

// The ONE place that resolves "which of this student's courses can a
// missed exam be recorded against" — the student's ACTIVE enrollments,
// each matched to its real LecturerCourseAssignment via the
// course+class+semester tuple (there's no direct enrollment->assignment
// relation in the schema — same resolution idiom as
// getMyTimetableForStudent in admin/timetable/queries.ts). Shared by the
// picker action AND recordMissedExam's own server-side re-validation, so
// a submitted assignmentId can never refer to a course the student isn't
// actually enrolled in. Dean-scoped per-ENROLLMENT (via the enrollment's
// own class), not just via the student's current class — same
// "a past enrollment under an out-of-scope class stays invisible" rule
// Dean Reports' per-student history already established.
export async function getStudentExamOptions(
  studentId: string,
  isDean: boolean,
  departmentIds: string[]
): Promise<StudentExamOption[]> {
  const enrollments = await prisma.studentCourseEnrollment.findMany({
    where: {
      studentId,
      status: "ACTIVE",
      ...(isDean ? { class: classDeanWhere(departmentIds) } : {}),
    },
    include: { course: true, class: true, semester: true },
  });
  if (enrollments.length === 0) return [];

  const assignments = await prisma.lecturerCourseAssignment.findMany({
    where: {
      OR: enrollments.map((e) => ({
        courseId: e.courseId,
        classId: e.classId,
        semesterId: e.semesterId,
      })),
    },
  });
  const assignmentByTuple = new Map(
    assignments.map((a) => [`${a.courseId}:${a.classId}:${a.semesterId}`, a])
  );

  const options: StudentExamOption[] = [];
  for (const e of enrollments) {
    const assignment = assignmentByTuple.get(
      `${e.courseId}:${e.classId}:${e.semesterId}`
    );
    if (!assignment) continue; // no matching assignment — defensively skipped, not shown
    options.push({
      assignmentId: assignment.id,
      courseId: e.course.id,
      courseName: e.course.name,
      courseCode: e.course.code,
      className: e.class.name,
      semesterId: e.semester.id,
      semesterName: e.semester.name,
    });
  }
  return options;
}
