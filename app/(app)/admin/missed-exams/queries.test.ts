import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  getUserAccess: vi.fn(),
}));

vi.mock("@/lib/dean-scope", () => ({
  getDeanDepartmentIds: vi.fn(),
  studentDeanWhere: vi.fn((ids: string[]) => ({
    class: { program: { departmentId: { in: ids } } },
  })),
  missedExamRecordDeanWhere: vi.fn((ids: string[]) => ({
    student: { class: { program: { departmentId: { in: ids } } } },
  })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    missedExamRecord: { findMany: vi.fn(), count: vi.fn() },
    specialExamPeriod: { findMany: vi.fn() },
    student: { findFirst: vi.fn() },
    studentCourseEnrollment: { findMany: vi.fn() },
  },
}));

import { getUserAccess } from "@/lib/auth";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import { prisma } from "@/lib/db";
import {
  buildMissedExamWhere,
  resolveMissedExamScope,
  getMissedExamRecords,
  getMissedExamPanelData,
  getActiveExamPeriodOptions,
  findStudentByNo,
  getStudentSemesterCourses,
} from "./queries";

function mockRoles(roleNames: string[]) {
  vi.mocked(getUserAccess).mockResolvedValue({
    permissions: new Set(),
    roleNames,
  } as never);
}

describe("buildMissedExamWhere", () => {
  it("ANDs the scope with every filter, matching course search directly (no enrollment nesting)", () => {
    const where = buildMissedExamWhere(
      { q: "jane", examType: "MIDTERM", reasonType: "ILLNESS" },
      { student: { class: { program: { departmentId: { in: ["dept-1"] } } } } }
    );
    expect(where).toEqual({
      AND: [
        { student: { class: { program: { departmentId: { in: ["dept-1"] } } } } },
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
      student: { class: { program: { departmentId: { in: ["dept-1"] } } } },
    });
    expect(scope.studentScope).toEqual({
      class: { program: { departmentId: { in: ["dept-1"] } } },
    });
  });
});

describe("findStudentByNo", () => {
  beforeEach(() => vi.resetAllMocks());

  it("ADMIN gets an unscoped, case-insensitive lookup", async () => {
    vi.mocked(prisma.student.findFirst).mockResolvedValue({
      id: "student-1",
      studentNo: "S1001",
      fullName: "Jane Doe",
    } as never);

    const result = await findStudentByNo("s1001", false, []);

    expect(result).toEqual({
      id: "student-1",
      studentNo: "S1001",
      fullName: "Jane Doe",
      className: null,
    });
    expect(prisma.student.findFirst).toHaveBeenCalledWith({
      where: { studentNo: { equals: "s1001", mode: "insensitive" } },
      select: { id: true, studentNo: true, fullName: true, class: { select: { name: true } } },
    });
  });

  it("DEAN gets the dean-scoped where-clause merged in", async () => {
    vi.mocked(prisma.student.findFirst).mockResolvedValue(null);

    await findStudentByNo("S1001", true, ["dept-1"]);

    expect(prisma.student.findFirst).toHaveBeenCalledWith({
      where: {
        studentNo: { equals: "S1001", mode: "insensitive" },
        class: { program: { departmentId: { in: ["dept-1"] } } },
      },
      select: { id: true, studentNo: true, fullName: true, class: { select: { name: true } } },
    });
  });
});

describe("getStudentSemesterCourses", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns only the student's non-DROPPED enrollments for that semester, deduped by course and sorted by name", async () => {
    const db = { id: "course-1", name: "Databases", code: "CS201" };
    const net = { id: "course-2", name: "Networking", code: "CS202" };
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([
      { course: net },
      { course: db },
      { course: db },
    ] as never);

    const result = await getStudentSemesterCourses("student-1", "sem-1");

    expect(result).toEqual([db, net]);
    expect(prisma.studentCourseEnrollment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          studentId: "student-1",
          semesterId: "sem-1",
          status: { not: "DROPPED" },
          course: { deletedAt: null },
        },
      })
    );
  });
});

describe("getMissedExamRecords", () => {
  beforeEach(() => vi.resetAllMocks());

  // Regression coverage for a real bug: a saved reasonNote wasn't
  // appearing in the "Recorded missed exams" table. The DB layer turned
  // out to be innocent — Prisma's `include` (used by
  // missedExamRecordInclude) returns every scalar column on the base
  // model by default, so reasonNote was never actually excluded from
  // what this query returns; the bug was purely in the client's JSX
  // never rendering it. This test pins the query side of that finding:
  // reasonNote passes through unchanged, so nothing here can regress
  // into hiding it from the data the table receives.
  it("passes reasonNote through unchanged — never dropped by the query layer", async () => {
    const dbRow = {
      id: "record-1",
      reasonNote: "Doctor's note attached, see file 42",
      examType: "MIDTERM",
      reasonType: "ILLNESS",
      student: { studentNo: "S1001", fullName: "Jane Doe", class: { name: "A", currentSemesterNumber: 1 } },
      course: { name: "Databases", code: "CS201" },
    };
    vi.mocked(prisma.missedExamRecord.findMany).mockResolvedValue([dbRow] as never);
    vi.mocked(prisma.missedExamRecord.count).mockResolvedValue(1);

    const { records } = await getMissedExamRecords({}, 0, 10);

    expect(records).toHaveLength(1);
    expect(records[0].reasonNote).toBe("Doctor's note attached, see file 42");
  });

  it("a null reasonNote also passes through unchanged", async () => {
    vi.mocked(prisma.missedExamRecord.findMany).mockResolvedValue([
      { id: "record-1", reasonNote: null },
    ] as never);
    vi.mocked(prisma.missedExamRecord.count).mockResolvedValue(1);

    const { records } = await getMissedExamRecords({}, 0, 10);

    expect(records[0].reasonNote).toBeNull();
  });
});

describe("getActiveExamPeriodOptions", () => {
  it("only ever offers OPEN periods — a CLOSED one isn't even selectable", async () => {
    vi.mocked(prisma.specialExamPeriod.findMany).mockResolvedValue([]);

    await getActiveExamPeriodOptions();

    expect(prisma.specialExamPeriod.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "OPEN" } })
    );
  });
});

describe("getMissedExamPanelData", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.missedExamRecord.findMany).mockResolvedValue([]);
    vi.mocked(prisma.missedExamRecord.count).mockResolvedValue(0);
    vi.mocked(prisma.specialExamPeriod.findMany).mockResolvedValue([]);
  });

  it("an unassigned DEAN gets the empty 'unassigned' shape without querying records", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue([]);

    const data = await getMissedExamPanelData("user-1", {});

    expect(data.unassigned).toBe(true);
    expect(data.records).toEqual([]);
    expect(data.periods).toEqual([]);
    expect(prisma.missedExamRecord.findMany).not.toHaveBeenCalled();
  });

  it("ADMIN gets the record list plus the active period options", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.specialExamPeriod.findMany).mockResolvedValue([
      { id: "period-1", name: "2026-2027 — Semester 1", semesterId: "sem-1", academicYearId: "ay-1" },
    ] as never);

    const data = await getMissedExamPanelData("user-1", {});

    expect(data.unassigned).toBe(false);
    expect(data.periods).toEqual([
      { id: "period-1", name: "2026-2027 — Semester 1", semesterId: "sem-1", academicYearId: "ay-1" },
    ]);
  });
});
