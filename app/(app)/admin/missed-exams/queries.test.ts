import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  getUserAccess: vi.fn(),
}));

vi.mock("@/lib/dean-scope", () => ({
  getDeanDepartmentIds: vi.fn(),
  studentDeanWhere: vi.fn((ids: string[]) => ({
    class: { program: { departmentId: { in: ids } } },
  })),
  enrollmentDeanWhere: vi.fn((ids: string[]) => ({
    class: { program: { departmentId: { in: ids } } },
  })),
  missedExamRecordDeanWhere: vi.fn((ids: string[]) => ({
    enrollment: { class: { program: { departmentId: { in: ids } } } },
  })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    missedExamRecord: { findMany: vi.fn(), count: vi.fn() },
    specialExamPeriod: { findMany: vi.fn() },
    student: { findFirst: vi.fn() },
    studentCourseEnrollment: { findMany: vi.fn() },
    classCoursePlan: { findMany: vi.fn() },
  },
}));

import { getUserAccess } from "@/lib/auth";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import { prisma } from "@/lib/db";
import {
  buildMissedExamWhere,
  resolveMissedExamScope,
  getMissedExamPanelData,
  getActiveExamPeriodOptions,
  findStudentByNo,
  getStudentEnrollmentRows,
  resolveSpecialExamPeriodParity,
  filterRowsByParity,
  type MissedExamGridRow,
} from "./queries";

function mockRoles(roleNames: string[]) {
  vi.mocked(getUserAccess).mockResolvedValue({
    permissions: new Set(),
    roleNames,
  } as never);
}

describe("buildMissedExamWhere", () => {
  it("ANDs the scope with every filter, nesting course search through enrollment", () => {
    const where = buildMissedExamWhere(
      { q: "jane", examType: "MIDTERM", reasonType: "ILLNESS" },
      { enrollment: { class: { program: { departmentId: { in: ["dept-1"] } } } } }
    );
    expect(where).toEqual({
      AND: [
        { enrollment: { class: { program: { departmentId: { in: ["dept-1"] } } } } },
        { examType: "MIDTERM" },
        { reasonType: "ILLNESS" },
        {
          OR: [
            { student: { fullName: { contains: "jane", mode: "insensitive" } } },
            { student: { studentNo: { contains: "jane", mode: "insensitive" } } },
            {
              enrollment: {
                course: { name: { contains: "jane", mode: "insensitive" } },
              },
            },
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
      enrollment: { class: { program: { departmentId: { in: ["dept-1"] } } } },
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

    expect(result).toEqual({ id: "student-1", studentNo: "S1001", fullName: "Jane Doe" });
    expect(prisma.student.findFirst).toHaveBeenCalledWith({
      where: { studentNo: { equals: "s1001", mode: "insensitive" } },
      select: { id: true, studentNo: true, fullName: true },
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
      select: { id: true, studentNo: true, fullName: true },
    });
  });
});

describe("getStudentEnrollmentRows", () => {
  beforeEach(() => vi.resetAllMocks());

  it("resolves every enrollment (any status), each to its ClassCoursePlan level by (classId, courseId)", async () => {
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([
      {
        id: "enr-1",
        classId: "class-1",
        courseId: "course-1",
        status: "ACTIVE",
        course: { id: "course-1", name: "Databases", code: "CS201" },
        class: { id: "class-1", name: "CMS26-A-FT" },
      },
      {
        id: "enr-2",
        classId: "class-1",
        courseId: "course-2",
        status: "COMPLETED",
        course: { id: "course-2", name: "Networking", code: "CS202" },
        class: { id: "class-1", name: "CMS26-A-FT" },
      },
    ] as never);
    vi.mocked(prisma.classCoursePlan.findMany).mockResolvedValue([
      { classId: "class-1", courseId: "course-1", semesterNumber: 3 },
      // course-2 has no plan row — resolves to a null level, not dropped
    ] as never);

    const rows = await getStudentEnrollmentRows("student-1", false, []);

    expect(rows).toEqual([
      {
        enrollmentId: "enr-1",
        courseId: "course-1",
        courseName: "Databases",
        courseCode: "CS201",
        className: "CMS26-A-FT",
        status: "ACTIVE",
        level: 3,
      },
      {
        enrollmentId: "enr-2",
        courseId: "course-2",
        courseName: "Networking",
        courseCode: "CS202",
        className: "CMS26-A-FT",
        status: "COMPLETED",
        level: null,
      },
    ]);
    expect(prisma.studentCourseEnrollment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { studentId: "student-1" } })
    );
  });

  it("a repeated course across two enrollments surfaces as two separate rows", async () => {
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([
      {
        id: "enr-1",
        classId: "class-1",
        courseId: "course-1",
        status: "DROPPED",
        course: { id: "course-1", name: "Databases", code: "CS201" },
        class: { id: "class-1", name: "CMS26-A-FT" },
      },
      {
        id: "enr-2",
        classId: "class-1",
        courseId: "course-1",
        status: "ACTIVE",
        course: { id: "course-1", name: "Databases", code: "CS201" },
        class: { id: "class-1", name: "CMS26-A-FT" },
      },
    ] as never);
    vi.mocked(prisma.classCoursePlan.findMany).mockResolvedValue([
      { classId: "class-1", courseId: "course-1", semesterNumber: 3 },
    ] as never);

    const rows = await getStudentEnrollmentRows("student-1", false, []);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.enrollmentId)).toEqual(["enr-1", "enr-2"]);
    expect(rows[0].status).toBe("DROPPED");
    expect(rows[1].status).toBe("ACTIVE");
  });

  it("DEAN scoping is applied per-enrollment (via each enrollment's own class)", async () => {
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([]);

    await getStudentEnrollmentRows("student-1", true, ["dept-1"]);

    expect(prisma.studentCourseEnrollment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          studentId: "student-1",
          class: { program: { departmentId: { in: ["dept-1"] } } },
        },
      })
    );
  });

  it("returns [] without querying ClassCoursePlan when there are no enrollments", async () => {
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([]);

    const rows = await getStudentEnrollmentRows("student-1", false, []);

    expect(rows).toEqual([]);
    expect(prisma.classCoursePlan.findMany).not.toHaveBeenCalled();
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

describe("resolveSpecialExamPeriodParity", () => {
  it("Semester 1 -> ODD, Semester 2 -> EVEN, anything else -> null (never guessed)", () => {
    expect(resolveSpecialExamPeriodParity(1)).toBe("ODD");
    expect(resolveSpecialExamPeriodParity(2)).toBe("EVEN");
    expect(resolveSpecialExamPeriodParity(null)).toBeNull();
  });
});

describe("filterRowsByParity", () => {
  const rows: MissedExamGridRow[] = [
    {
      enrollmentId: "e1",
      courseId: "c1",
      courseName: "A",
      courseCode: "A1",
      className: "Class A",
      status: "ACTIVE",
      level: 1,
    },
    {
      enrollmentId: "e2",
      courseId: "c2",
      courseName: "B",
      courseCode: "B1",
      className: "Class A",
      status: "ACTIVE",
      level: 2,
    },
    {
      enrollmentId: "e3",
      courseId: "c3",
      courseName: "C",
      courseCode: "C1",
      className: "Class A",
      status: "ACTIVE",
      level: null,
    },
  ];

  it("ODD keeps only odd-level rows", () => {
    expect(filterRowsByParity(rows, "ODD").map((r) => r.enrollmentId)).toEqual(["e1"]);
  });

  it("EVEN keeps only even-level rows", () => {
    expect(filterRowsByParity(rows, "EVEN").map((r) => r.enrollmentId)).toEqual(["e2"]);
  });

  it("a null (unresolved) level never matches either parity", () => {
    expect(filterRowsByParity(rows, "ODD").some((r) => r.enrollmentId === "e3")).toBe(false);
    expect(filterRowsByParity(rows, "EVEN").some((r) => r.enrollmentId === "e3")).toBe(false);
  });

  it("null parity (semesterNumber not set) returns every row unfiltered", () => {
    expect(filterRowsByParity(rows, null)).toEqual(rows);
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
