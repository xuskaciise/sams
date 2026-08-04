import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    dailyLogEntry: { findMany: vi.fn(), count: vi.fn() },
    department: { findMany: vi.fn() },
    lecturer: { findMany: vi.fn() },
    student: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({
  getUserAccess: vi.fn(),
}));

vi.mock("@/lib/dean-scope", () => ({
  getDeanDepartmentIds: vi.fn(),
  dailyLogDeanWhere: vi.fn((ids: string[]) => ({ departmentId: { in: ids } })),
  studentDeanWhere: vi.fn((ids: string[]) => ({
    class: { program: { departmentId: { in: ids } } },
  })),
}));

import { prisma } from "@/lib/db";
import { getUserAccess } from "@/lib/auth";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import {
  buildDailyLogWhere,
  getDailyLogPanelData,
  getMyLeaveNotices,
  getMyLeaveNoticesForStudent,
} from "./queries";

describe("buildDailyLogWhere", () => {
  it("returns an empty where when no scope or filters are given", () => {
    expect(buildDailyLogWhere({})).toEqual({});
  });

  it("ANDs the scope with every active filter", () => {
    const where = buildDailyLogWhere(
      { departmentId: "dept-cs", type: "PROBLEM", q: "projector" },
      { departmentId: { in: ["dept-cs", "dept-eng"] } }
    );

    expect(where).toEqual({
      AND: [
        { departmentId: { in: ["dept-cs", "dept-eng"] } },
        { departmentId: "dept-cs" },
        { type: "PROBLEM" },
        {
          OR: [
            { title: { contains: "projector", mode: "insensitive" } },
            { description: { contains: "projector", mode: "insensitive" } },
          ],
        },
      ],
    });
  });

  it("filters entryDate to the given single day", () => {
    const where = buildDailyLogWhere({ date: "2026-07-22" });
    expect(where).toEqual({
      AND: [
        {
          entryDate: {
            gte: new Date("2026-07-22T00:00:00.000Z"),
            lte: new Date("2026-07-22T23:59:59.999Z"),
          },
        },
      ],
    });
  });

  it("a filter outside the scope still ANDs in, so it just yields zero rows rather than escaping the scope", () => {
    const where = buildDailyLogWhere(
      { departmentId: "dept-outside" },
      { departmentId: { in: ["dept-cs"] } }
    );
    expect(where).toEqual({
      AND: [
        { departmentId: { in: ["dept-cs"] } },
        { departmentId: "dept-outside" },
      ],
    });
  });
});

describe("getDailyLogPanelData", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.dailyLogEntry.findMany).mockResolvedValue([]);
    vi.mocked(prisma.dailyLogEntry.count).mockResolvedValue(0);
    vi.mocked(prisma.department.findMany).mockResolvedValue([]);
    vi.mocked(prisma.lecturer.findMany).mockResolvedValue([]);
    vi.mocked(prisma.student.findMany).mockResolvedValue([]);
  });

  it("a pure ADMIN sees every non-deleted department and every active lecturer — no dean-scope call at all", async () => {
    vi.mocked(getUserAccess).mockResolvedValue({
      permissions: new Set(),
      roleNames: ["ADMIN"],
    } as never);

    const data = await getDailyLogPanelData("admin-1", {});

    expect(getDeanDepartmentIds).not.toHaveBeenCalled();
    expect(data.unassigned).toBe(false);
    expect(prisma.department.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } })
    );
    expect(prisma.lecturer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { OR: [{ userId: null }, { user: { deletedAt: null } }] } })
    );
    expect(prisma.student.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} })
    );
    expect(prisma.dailyLogEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} })
    );
  });

  it("a DEAN is scoped to their own dean_departments for entries and the department list", async () => {
    vi.mocked(getUserAccess).mockResolvedValue({
      permissions: new Set(),
      roleNames: ["DEAN"],
    } as never);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);

    const data = await getDailyLogPanelData("dean-1", {});

    expect(data.unassigned).toBe(false);
    expect(prisma.dailyLogEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{ departmentId: { in: ["dept-cs"] } }] },
      })
    );
    expect(prisma.department.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["dept-cs"] } } })
    );
  });

  it("the lecturer list is NEVER dean-scoped, even for a DEAN — every active lecturer is offered, since a faculty with zero current assignments would otherwise show none", async () => {
    vi.mocked(getUserAccess).mockResolvedValue({
      permissions: new Set(),
      roleNames: ["DEAN"],
    } as never);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);

    await getDailyLogPanelData("dean-1", {});

    expect(prisma.lecturer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { OR: [{ userId: null }, { user: { deletedAt: null } }] } })
    );
  });

  it("the student list IS dean-scoped via studentDeanWhere — unlike lecturers, every student has a real home department", async () => {
    vi.mocked(getUserAccess).mockResolvedValue({
      permissions: new Set(),
      roleNames: ["DEAN"],
    } as never);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);

    await getDailyLogPanelData("dean-1", {});

    expect(prisma.student.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { class: { program: { departmentId: { in: ["dept-cs"] } } } },
      })
    );
  });

  it("an unassigned DEAN gets the empty/unassigned shape without ever querying entries", async () => {
    vi.mocked(getUserAccess).mockResolvedValue({
      permissions: new Set(),
      roleNames: ["DEAN"],
    } as never);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue([]);

    const data = await getDailyLogPanelData("dean-2", {});

    expect(data).toEqual({
      entries: [],
      total: 0,
      page: 1,
      pageSize: 10,
      departments: [],
      lecturers: [],
      students: [],
      unassigned: true,
    });
    expect(prisma.dailyLogEntry.findMany).not.toHaveBeenCalled();
  });

  it("a DEAN+ADMIN multi-role user is still scoped as a DEAN — role check, not permission check", async () => {
    vi.mocked(getUserAccess).mockResolvedValue({
      permissions: new Set(),
      roleNames: ["ADMIN", "DEAN"],
    } as never);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);

    const data = await getDailyLogPanelData("multi-1", {});

    expect(data.unassigned).toBe(false);
    expect(prisma.department.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["dept-cs"] } } })
    );
  });
});

describe("getMyLeaveNotices", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.dailyLogEntry.findMany).mockResolvedValue([]);
  });

  it("scopes to LEAVE_NOTICE entries naming this lecturer — the query IS the ownership check", async () => {
    await getMyLeaveNotices("lecturer-user-1");

    expect(prisma.dailyLogEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          type: "LEAVE_NOTICE",
          relatedLecturer: { userId: "lecturer-user-1" },
        },
      })
    );
  });

  it("defaults to the 5 most recent, but accepts a custom limit", async () => {
    await getMyLeaveNotices("lecturer-user-1");
    expect(prisma.dailyLogEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5, orderBy: { entryDate: "desc" } })
    );

    await getMyLeaveNotices("lecturer-user-1", 10);
    expect(prisma.dailyLogEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10 })
    );
  });
});

// Regression test: a real LEAVE_NOTICE entry with relatedStudentId
// pointing at a student must actually surface for that student's
// session. Root cause of the original bug report was that no
// student-facing query existed at all (relatedStudentId was wired up
// for the ADMIN/DEAN list and the create form, but never read back out
// for a student) — this pins the fix in place.
describe("getMyLeaveNoticesForStudent", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.dailyLogEntry.findMany).mockResolvedValue([]);
  });

  it("scopes to LEAVE_NOTICE entries naming this student — the query IS the ownership check", async () => {
    await getMyLeaveNoticesForStudent("student-user-1");

    expect(prisma.dailyLogEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          type: "LEAVE_NOTICE",
          relatedStudent: { userId: "student-user-1" },
        },
      })
    );
  });

  it("returns a real LEAVE_NOTICE row when the student it names is querying — the actual reported bug", async () => {
    const entry = {
      id: "entry-1",
      type: "LEAVE_NOTICE",
      title: "Leave notice — ahmed",
      relatedStudentId: "student-1",
      department: { name: "Health Science" },
      author: { fullName: "Dean User" },
    };
    vi.mocked(prisma.dailyLogEntry.findMany).mockResolvedValue([entry] as never);

    const result = await getMyLeaveNoticesForStudent("student-user-1");

    expect(result).toEqual([entry]);
  });

  it("defaults to the 5 most recent, but accepts a custom limit", async () => {
    await getMyLeaveNoticesForStudent("student-user-1");
    expect(prisma.dailyLogEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5, orderBy: { entryDate: "desc" } })
    );

    await getMyLeaveNoticesForStudent("student-user-1", 10);
    expect(prisma.dailyLogEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10 })
    );
  });
});
