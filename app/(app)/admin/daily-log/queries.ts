import type { Prisma, DailyLogType, Department, Lecturer, User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getUserAccess } from "@/lib/auth";
import {
  getDeanDepartmentIds,
  dailyLogDeanWhere,
  lecturerDeanWhere,
} from "@/lib/dean-scope";
import { resolvePageParams } from "@/lib/pagination";

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
        relatedLecturer: { include: { user: { select: { fullName: true } } } },
      },
      orderBy: { entryDate: "desc" },
      skip,
      take,
    }),
    prisma.dailyLogEntry.count({ where }),
  ]);
  return { entries, total };
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
  lecturers: (Lecturer & { user: User })[];
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
// dailyLogDeanWhere/lecturerDeanWhere — reused, never duplicated.
export async function getDailyLogPanelData(
  userId: string,
  searchParams: DailyLogPanelSearchParams
): Promise<DailyLogPanelData> {
  const { roleNames } = await getUserAccess(userId);
  const isDean = roleNames.includes("DEAN");

  let scope: Prisma.DailyLogEntryWhereInput | undefined;
  let departmentWhere: Prisma.DepartmentWhereInput = { deletedAt: null };
  let lecturerScope: Prisma.LecturerWhereInput = {};

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
        unassigned: true,
      };
    }
    scope = dailyLogDeanWhere(departmentIds);
    departmentWhere = { id: { in: departmentIds } };
    lecturerScope = lecturerDeanWhere(departmentIds);
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

  const [{ entries, total }, departments, lecturers] = await Promise.all([
    getDailyLogEntries(where, skip, take),
    prisma.department.findMany({
      where: departmentWhere,
      orderBy: { name: "asc" },
    }),
    prisma.lecturer.findMany({
      include: { user: true },
      where: { user: { deletedAt: null }, ...lecturerScope },
      orderBy: { user: { fullName: "asc" } },
    }),
  ]);

  return { entries, total, page, pageSize, departments, lecturers, unassigned: false };
}
