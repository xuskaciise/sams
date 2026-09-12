import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  getUserAccess: vi.fn(),
}));

vi.mock("@/lib/dean-scope", () => ({
  getDeanDepartmentIds: vi.fn(),
  classDeanWhere: vi.fn((ids: string[]) => ({
    program: { departmentId: { in: ids } },
  })),
  studentDeanWhere: vi.fn((ids: string[]) => ({
    class: { program: { departmentId: { in: ids } } },
  })),
  missedExamRecordDeanWhere: vi.fn((ids: string[]) => ({
    assignment: { class: { program: { departmentId: { in: ids } } } },
  })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    missedExamRecord: { findMany: vi.fn(), count: vi.fn() },
    student: { findMany: vi.fn() },
  },
}));

import { getUserAccess } from "@/lib/auth";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import { prisma } from "@/lib/db";
import {
  buildMissedExamWhere,
  resolveMissedExamScope,
  getMissedExamPanelData,
} from "./queries";

function mockRoles(roleNames: string[]) {
  vi.mocked(getUserAccess).mockResolvedValue({
    permissions: new Set(),
    roleNames,
  } as never);
}

describe("buildMissedExamWhere", () => {
  it("ANDs the scope with every filter", () => {
    const where = buildMissedExamWhere(
      { q: "jane", examType: "MIDTERM", reasonType: "ILLNESS" },
      { assignment: { class: { program: { departmentId: { in: ["dept-1"] } } } } }
    );
    expect(where).toEqual({
      AND: [
        { assignment: { class: { program: { departmentId: { in: ["dept-1"] } } } } },
        { examType: "MIDTERM" },
        { reasonType: "ILLNESS" },
        {
          OR: [
            { student: { fullName: { contains: "jane", mode: "insensitive" } } },
            { student: { studentNo: { contains: "jane", mode: "insensitive" } } },
            { course: { name: { contains: "jane", mode: "insensitive" } } },
          ],
        },
      ],
    });
  });

  it("returns {} when there's no scope and no filters", () => {
    expect(buildMissedExamWhere({})).toEqual({});
  });
});

describe("resolveMissedExamScope", () => {
  beforeEach(() => vi.resetAllMocks());

  it("a pure ADMIN gets no scope at all", async () => {
    mockRoles(["ADMIN"]);
    const scope = await resolveMissedExamScope("user-1");
    expect(scope).toEqual({
      isDean: false,
      departmentIds: [],
      recordScope: undefined,
      studentScope: {},
    });
    expect(getDeanDepartmentIds).not.toHaveBeenCalled();
  });

  it("a DEAN (even DEAN+ADMIN) gets exactly their own dean_departments scope", async () => {
    mockRoles(["ADMIN", "DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-1"]);
    const scope = await resolveMissedExamScope("user-1");
    expect(scope.isDean).toBe(true);
    expect(scope.departmentIds).toEqual(["dept-1"]);
    expect(scope.recordScope).toEqual({
      assignment: { class: { program: { departmentId: { in: ["dept-1"] } } } },
    });
  });
});

describe("getMissedExamPanelData", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.missedExamRecord.findMany).mockResolvedValue([]);
    vi.mocked(prisma.missedExamRecord.count).mockResolvedValue(0);
    vi.mocked(prisma.student.findMany).mockResolvedValue([]);
  });

  it("an unassigned DEAN gets the empty 'unassigned' shape without querying records/students", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue([]);

    const data = await getMissedExamPanelData("user-1", {});

    expect(data.unassigned).toBe(true);
    expect(data.records).toEqual([]);
    expect(data.students).toEqual([]);
    expect(prisma.missedExamRecord.findMany).not.toHaveBeenCalled();
  });

  it("ADMIN gets an unscoped student list", async () => {
    mockRoles(["ADMIN"]);

    await getMissedExamPanelData("user-1", {});

    expect(prisma.student.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} })
    );
  });
});
