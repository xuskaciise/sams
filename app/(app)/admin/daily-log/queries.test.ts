import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    dailyLogEntry: { findMany: vi.fn(), count: vi.fn() },
    department: { findMany: vi.fn() },
    lecturer: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({
  getUserAccess: vi.fn(),
}));

vi.mock("@/lib/dean-scope", () => ({
  getDeanDepartmentIds: vi.fn(),
  dailyLogDeanWhere: vi.fn((ids: string[]) => ({ departmentId: { in: ids } })),
  lecturerDeanWhere: vi.fn((ids: string[]) => ({
    assignments: { some: { class: { program: { departmentId: { in: ids } } } } },
  })),
}));

import { prisma } from "@/lib/db";
import { getUserAccess } from "@/lib/auth";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import { buildDailyLogWhere, getDailyLogPanelData } from "./queries";

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
      expect.objectContaining({ where: { user: { deletedAt: null } } })
    );
    expect(prisma.dailyLogEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} })
    );
  });

  it("a DEAN is scoped to their own dean_departments for entries, department list, and lecturer list", async () => {
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
    expect(prisma.lecturer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          user: { deletedAt: null },
          assignments: { some: { class: { program: { departmentId: { in: ["dept-cs"] } } } } },
        },
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
