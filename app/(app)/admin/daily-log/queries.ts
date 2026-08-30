import type {
  Prisma,
  DailyLogType,
  DailyLogEntrySession,
  Department,
  Lecturer,
  Student,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { getUserAccess } from "@/lib/auth";
import {
  getDeanDepartmentIds,
  dailyLogDeanWhere,
  studentDeanWhere,
} from "@/lib/dean-scope";
import { resolvePageParams } from "@/lib/pagination";
import { nullableDecimalToNumber } from "@/lib/serialize";
import { dayOfWeekFromISODate, sessionDurationHours } from "@/lib/leave-hours";

export interface DailyLogFilters {
  departmentId?: string;
  type?: string;
  date?: string; // "YYYY-MM-DD", filters entryDate to that single day
  q?: string;
}

// Shared by both the Admin panel (no scope) and the Dean panel (scope =
// dailyLogDeanWhere(departmentIds)) — filters always AND on top of
// whatever scope the caller passes in, so a Dean filtering by a
// department outside their own set just gets zero rows, never a leak.
export function buildDailyLogWhere(
  filters: DailyLogFilters,
  scope?: Prisma.DailyLogEntryWhereInput
): Prisma.DailyLogEntryWhereInput {
  const conditions: Prisma.DailyLogEntryWhereInput[] = [];
  if (scope) conditions.push(scope);
  if (filters.departmentId) conditions.push({ departmentId: filters.departmentId });
  if (filters.type) {
    conditions.push({ type: filters.type as DailyLogType });
  }
  if (filters.date) {
    const start = new Date(`${filters.date}T00:00:00.000Z`);
    const end = new Date(`${filters.date}T23:59:59.999Z`);
    conditions.push({ entryDate: { gte: start, lte: end } });
  }
  if (filters.q) {
    conditions.push({
      OR: [
        { title: { contains: filters.q, mode: "insensitive" } },
        { description: { contains: filters.q, mode: "insensitive" } },
      ],
    });
  }
  return conditions.length > 0 ? { AND: conditions } : {};
}

// `leaveHours` (nullable Decimal) and each session's `hours` (Decimal)
// must be plain numbers before crossing to a Client Component — see
// lib/serialize.ts. Sessions are ordered by start time so the list reads
// chronologically wherever it's shown.
const dailyLogSessionInclude = { orderBy: { startTime: "asc" } } as const;

export interface DailyLogSessionView {
  id: string;
  timetableSlotId: string | null;
  courseName: string;
  className: string;
  startTime: string;
  endTime: string;
  hours: number;
}

function serializeSessions(
  sessions: DailyLogEntrySession[] | undefined
): DailyLogSessionView[] {
  return (sessions ?? []).map((s) => ({
    id: s.id,
    timetableSlotId: s.timetableSlotId,
    courseName: s.courseName,
    className: s.className,
    startTime: s.startTime,
    endTime: s.endTime,
    hours: Number(s.hours),
  }));
}

function serializeDailyLogEntry<
  T extends {
    leaveHours: Prisma.Decimal | null;
    sessions?: DailyLogEntrySession[];
  },
>(entry: T) {
  return {
    ...entry,
    leaveHours: nullableDecimalToNumber(entry.leaveHours),
    sessions: serializeSessions(entry.sessions),
  };
}

export async function getDailyLogEntries(
  where: Prisma.DailyLogEntryWhereInput,
  skip: number,
  take: number
) {
  const [entries, total] = await Promise.all([
    prisma.dailyLogEntry.findMany({
      where,
      include: {
        department: true,
        author: { select: { fullName: true } },
        relatedLecturer: { select: { fullName: true } },
        relatedStudent: { select: { studentNo: true, fullName: true } },
        sessions: dailyLogSessionInclude,
      },
      orderBy: { entryDate: "desc" },
      skip,
      take,
    }),
    prisma.dailyLogEntry.count({ where }),
  ]);
  return { entries: entries.map(serializeDailyLogEntry), total };
}

// Note: `department`, not `departmentId` — matches the URL query param
// name the client writes via table.setFilter("department", …).
export interface DailyLogPanelSearchParams {
  department?: string;
  type?: string;
  date?: string;
  q?: string;
  page?: string;
  pageSize?: string;
}

export interface DailyLogPanelData {
  entries: Awaited<ReturnType<typeof getDailyLogEntries>>["entries"];
  total: number;
  page: number;
  pageSize: number;
  departments: Department[];
  lecturers: Lecturer[];
  students: Student[];
  unassigned: boolean;
}

// The ONE place that decides WHAT a caller sees, regardless of which route
// (/admin/daily-log or /dean/daily-log) rendered it: dailylog.view is held
// by both ADMIN and DEAN, so the route/nav-item alone can't be trusted as
// the scoping boundary (a Dean could still reach the admin URL, or vice
// versa) — this function re-derives the real boundary from the caller's
// ROLE every time, same as createDailyLogEntry does for writes. A pure
// ADMIN gets every faculty; a DEAN (even a DEAN+ADMIN multi-role user)
// always gets exactly their own dean_departments scope, applied via
// dailyLogDeanWhere — reused, never duplicated.
//
// The lecturer picker is deliberately NOT scoped by lecturerDeanWhere
// (unlike Ownership Transfer): that helper means "lecturers currently
// holding an assignment in-scope", which is the right pool when
// reassigning existing teaching work, but wrong here — a faculty with no
// active assignments yet (a new/quiet department, between semesters)
// would show zero pickable lecturers, and there's a real need to log a
// leave notice for a lecturer regardless of whether they're mid-teaching
// right now. The schema has no direct Lecturer->Department relation to
// scope by instead, so every active lecturer is offered to both ADMIN and
// DEAN — the entry itself still only ever gets created in the caller's
// own faculty (departmentId), so this is a picker-convenience choice, not
// a scoping gap: which lecturer gets NAMED in a leave notice isn't the
// security boundary, which faculty the entry is filed under is.
//
// The student picker is the opposite case: a student always has a real
// home department (via class -> program), so it IS scoped by
// studentDeanWhere for a DEAN — same reasoning as createDailyLogEntry's
// relatedStudentId validation.
export async function getDailyLogPanelData(
  userId: string,
  searchParams: DailyLogPanelSearchParams
): Promise<DailyLogPanelData> {
  const { roleNames } = await getUserAccess(userId);
  const isDean = roleNames.includes("DEAN");

  let scope: Prisma.DailyLogEntryWhereInput | undefined;
  let departmentWhere: Prisma.DepartmentWhereInput = { deletedAt: null };
  let studentWhere: Prisma.StudentWhereInput = {};

  if (isDean) {
    const departmentIds = await getDeanDepartmentIds(userId);
    if (departmentIds.length === 0) {
      return {
        entries: [],
        total: 0,
        page: 1,
        pageSize: 10,
        departments: [],
        lecturers: [],
        students: [],
        unassigned: true,
      };
    }
    scope = dailyLogDeanWhere(departmentIds);
    departmentWhere = { id: { in: departmentIds } };
    studentWhere = studentDeanWhere(departmentIds);
  }

  const { page, pageSize, skip, take } = resolvePageParams(searchParams);
  const where = buildDailyLogWhere(
    {
      departmentId: searchParams.department,
      type: searchParams.type,
      date: searchParams.date,
      q: searchParams.q,
    },
    scope
  );

  const [{ entries, total }, departments, lecturers, students] = await Promise.all([
    getDailyLogEntries(where, skip, take),
    prisma.department.findMany({
      where: departmentWhere,
      orderBy: { name: "asc" },
    }),
    // Lecturers with no account yet are still valid "about" subjects for a
    // leave notice — only a deactivated account excludes one.
    prisma.lecturer.findMany({
      where: { OR: [{ userId: null }, { user: { deletedAt: null } }] },
      orderBy: { fullName: "asc" },
    }),
    prisma.student.findMany({
      where: studentWhere,
      orderBy: { fullName: "asc" },
    }),
  ]);

  return {
    entries,
    total,
    page,
    pageSize,
    departments,
    lecturers,
    students,
    unassigned: false,
  };
}

// Lecturer's own read-only view (dailylog.view.own) — the scope check IS
// the query: filtering through the relatedLecturer relation's own userId
// means a lecturer only ever sees entries that name them, with no
// separate existence/ownership check needed. relatedLecturerId is only
// ever set for LEAVE_NOTICE (see actions.ts), so the explicit type filter
// here is defensive belt-and-suspenders, not load-bearing.
export async function getMyLeaveNotices(userId: string, take = 5) {
  const rows = await prisma.dailyLogEntry.findMany({
    where: { type: "LEAVE_NOTICE", relatedLecturer: { userId } },
    include: {
      department: true,
      author: { select: { fullName: true } },
      sessions: dailyLogSessionInclude,
    },
    orderBy: { entryDate: "desc" },
    take,
  });
  return rows.map(serializeDailyLogEntry);
}

// Student's own read-only view (dailylog.view.own) — exact same idiom as
// getMyLeaveNotices above, just through relatedStudent instead of
// relatedLecturer. `userId` here is the SESSION user id (User.id), not
// Student.id — the relation filter does that join for us
// (relatedStudent.userId = userId), so there's never a raw
// userId-vs-Student.id comparison to get wrong.
export async function getMyLeaveNoticesForStudent(userId: string, take = 5) {
  const rows = await prisma.dailyLogEntry.findMany({
    where: { type: "LEAVE_NOTICE", relatedStudent: { userId } },
    include: {
      department: true,
      author: { select: { fullName: true } },
      sessions: dailyLogSessionInclude,
    },
    orderBy: { entryDate: "desc" },
    take,
  });
  return rows.map(serializeDailyLogEntry);
}

// Total STORED leave hours for one person in the current active semester
// (falls back to all-time when there's no active semester). Summed from
// the per-entry `leaveHours` SNAPSHOT via prisma.aggregate — never
// recomputed from the linked sessions, so a later timetable edit can't
// move a historical total. Drives the "N hours of leave this semester"
// line on the lecturer/student "My Leave Notices" widget, which shows
// only the 5 most recent entries but must total ALL of them.
export async function getMyLeaveHoursSummary(
  userId: string,
  opts: { forStudent?: boolean } = {}
): Promise<{ totalHours: number; entryCount: number; scopedToSemester: boolean }> {
  const activeSemester = await prisma.semester.findFirst({
    where: { isActive: true },
    select: { startDate: true, endDate: true },
  });

  const where: Prisma.DailyLogEntryWhereInput = {
    type: "LEAVE_NOTICE",
    ...(opts.forStudent
      ? { relatedStudent: { userId } }
      : { relatedLecturer: { userId } }),
    ...(activeSemester
      ? {
          entryDate: {
            gte: activeSemester.startDate,
            lte: activeSemester.endDate,
          },
        }
      : {}),
  };

  const [agg, entryCount] = await Promise.all([
    prisma.dailyLogEntry.aggregate({ _sum: { leaveHours: true }, where }),
    prisma.dailyLogEntry.count({ where }),
  ]);

  return {
    totalHours: agg._sum.leaveHours ? Number(agg._sum.leaveHours) : 0,
    entryCount,
    scopedToSemester: !!activeSemester,
  };
}

export interface LeaveNoticeSessionOption {
  id: string;
  courseName: string;
  className: string;
  startTime: string;
  endTime: string;
  hours: number;
}

// The ONE place that resolves "which scheduled sessions could this leave
// notice cover" — the person + the date's day-of-week, within the active
// semester. Shared by the form's live preview action
// (getLeaveNoticeSessions) AND createDailyLogEntry's server-side
// re-validation, so a submitted session id can never link to something
// the preview wouldn't have offered. Lecturer: every session they teach
// that day, across any class. Student: their own class's sessions that
// day. No dean-scoping here — the person was already picked from a
// role-scoped picker (student list is studentDeanWhere-scoped; lecturer
// list is deliberately unscoped, see getDailyLogPanelData) and the
// entry's own departmentId is the real boundary.
export async function fetchLeaveSessionSlots(params: {
  relatedLecturerId?: string | null;
  relatedStudentId?: string | null;
  entryDate: string;
}) {
  const dayOfWeek = dayOfWeekFromISODate(params.entryDate);
  if (!dayOfWeek) return [];

  const include = {
    assignment: { include: { course: true, class: true } },
  } as const;

  if (params.relatedLecturerId) {
    return prisma.timetableSlot.findMany({
      where: {
        dayOfWeek,
        assignment: {
          lecturerId: params.relatedLecturerId,
          semester: { isActive: true },
        },
      },
      include,
      orderBy: { startTime: "asc" },
    });
  }

  if (params.relatedStudentId) {
    const student = await prisma.student.findUnique({
      where: { id: params.relatedStudentId },
      select: { classId: true },
    });
    if (!student) return [];
    return prisma.timetableSlot.findMany({
      where: {
        dayOfWeek,
        assignment: {
          classId: student.classId,
          semester: { isActive: true },
        },
      },
      include,
      orderBy: { startTime: "asc" },
    });
  }

  return [];
}

export function toLeaveNoticeSessionOptions(
  slots: Awaited<ReturnType<typeof fetchLeaveSessionSlots>>
): LeaveNoticeSessionOption[] {
  return slots.map((s) => ({
    id: s.id,
    courseName: s.assignment.course.name,
    className: s.assignment.class.name,
    startTime: s.startTime,
    endTime: s.endTime,
    hours: sessionDurationHours(s.startTime, s.endTime),
  }));
}
