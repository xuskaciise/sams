import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  getUserAccess: vi.fn(),
}));

vi.mock("@/lib/dean-scope", () => ({
  getDeanDepartmentIds: vi.fn(),
  classDeanWhere: vi.fn((ids: string[]) => ({
    program: { departmentId: { in: ids } },
  })),
  missedExamRecordDeanWhere: vi.fn((ids: string[]) => ({
    assignment: { class: { program: { departmentId: { in: ids } } } },
  })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    missedExamRecord: { findMany: vi.fn(), count: vi.fn() },
    specialExamPeriod: { findMany: vi.fn() },
    semester: { findFirst: vi.fn() },
    class: { findMany: vi.fn() },
    studentCourseEnrollment: { findMany: vi.fn() },
    lecturerCourseAssignment: { findMany: vi.fn() },
  },
}));

import { getUserAccess } from "@/lib/auth";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import { prisma } from "@/lib/db";
import {
  buildMissedExamWhere,
  resolveMissedExamScope,
  getMissedExamPanelData,
  getClassLevelsForScope,
  getClassesForLevel,
  getMissedExamGridRows,
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
    expect(scope).toEqual({ isDean: false, departmentIds: [], recordScope: undefined });
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

describe("getClassLevelsForScope", () => {
  beforeEach(() => vi.resetAllMocks());

  it("ADMIN gets an unscoped distinct-level query", async () => {
    vi.mocked(prisma.class.findMany).mockResolvedValue([
      { currentSemesterNumber: 3 },
      { currentSemesterNumber: 1 },
    ] as never);

    const levels = await getClassLevelsForScope(false, []);

    expect(levels).toEqual([1, 3]);
    expect(prisma.class.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: null, currentSemesterNumber: { not: null } },
      })
    );
  });

  it("DEAN gets the dean-scoped where-clause merged in", async () => {
    vi.mocked(prisma.class.findMany).mockResolvedValue([]);

    await getClassLevelsForScope(true, ["dept-1"]);

    expect(prisma.class.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletedAt: null,
          currentSemesterNumber: { not: null },
          program: { departmentId: { in: ["dept-1"] } },
        },
      })
    );
  });
});

describe("getClassesForLevel", () => {
  beforeEach(() => vi.resetAllMocks());

  it("filters by the exact level and merges dean scope when given", async () => {
    vi.mocked(prisma.class.findMany).mockResolvedValue([]);

    await getClassesForLevel(3, true, ["dept-1"]);

    expect(prisma.class.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletedAt: null,
          currentSemesterNumber: 3,
          program: { departmentId: { in: ["dept-1"] } },
        },
      })
    );
  });
});

describe("getMissedExamGridRows", () => {
  beforeEach(() => vi.resetAllMocks());

  it("matches each ACTIVE enrollment to its real assignment by courseId, skipping unmatched ones", async () => {
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([
      {
        id: "enr-1",
        courseId: "course-1",
        student: { id: "student-1", studentNo: "S1", fullName: "Alice" },
        course: { id: "course-1", name: "Databases", code: "CS201" },
      },
      {
        id: "enr-2",
        courseId: "course-2",
        student: { id: "student-2", studentNo: "S2", fullName: "Bob" },
        course: { id: "course-2", name: "Networking", code: "CS202" },
      },
    ] as never);
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      { id: "assign-1", courseId: "course-1" },
      // course-2 has no assignment — its enrollment must be skipped
    ] as never);

    const rows = await getMissedExamGridRows("class-1", "sem-1");

    expect(rows).toEqual([
      {
        enrollmentId: "enr-1",
        studentId: "student-1",
        studentNo: "S1",
        studentFullName: "Alice",
        courseId: "course-1",
        courseName: "Databases",
        courseCode: "CS201",
        assignmentId: "assign-1",
      },
    ]);
    expect(prisma.studentCourseEnrollment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { classId: "class-1", semesterId: "sem-1", status: "ACTIVE" },
      })
    );
  });

  it("returns [] without querying assignments when there are no enrollments", async () => {
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([]);

    const rows = await getMissedExamGridRows("class-1", "sem-1");

    expect(rows).toEqual([]);
  });
});

describe("getMissedExamPanelData", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.missedExamRecord.findMany).mockResolvedValue([]);
    vi.mocked(prisma.missedExamRecord.count).mockResolvedValue(0);
    vi.mocked(prisma.specialExamPeriod.findMany).mockResolvedValue([]);
    vi.mocked(prisma.semester.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.class.findMany).mockResolvedValue([]);
  });

  it("an unassigned DEAN gets the empty 'unassigned' shape without querying anything else", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue([]);

    const data = await getMissedExamPanelData("user-1", {});

    expect(data.unassigned).toBe(true);
    expect(data.records).toEqual([]);
    expect(data.periods).toEqual([]);
    expect(data.classLevels).toEqual([]);
    expect(prisma.missedExamRecord.findMany).not.toHaveBeenCalled();
  });

  it("ADMIN gets periods, active semester id, and class levels alongside the record list", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.specialExamPeriod.findMany).mockResolvedValue([
      { id: "period-1", name: "2026-2027 — Semester 1", semesterId: "sem-1", academicYearId: "ay-1" },
    ] as never);
    vi.mocked(prisma.semester.findFirst).mockResolvedValue({ id: "sem-1" } as never);
    vi.mocked(prisma.class.findMany).mockResolvedValue([{ currentSemesterNumber: 1 }] as never);

    const data = await getMissedExamPanelData("user-1", {});

    expect(data.unassigned).toBe(false);
    expect(data.periods).toEqual([
      { id: "period-1", name: "2026-2027 — Semester 1", semesterId: "sem-1", academicYearId: "ay-1" },
    ]);
    expect(data.activeSemesterId).toBe("sem-1");
    expect(data.classLevels).toEqual([1]);
  });
});
