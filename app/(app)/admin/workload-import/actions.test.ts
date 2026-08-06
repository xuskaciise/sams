import { describe, it, expect, vi, beforeEach } from "vitest";

const mockUser = { id: "user-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
  getUserAccess: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/enrollment", () => ({
  autoEnrollClassIntoAssignment: vi.fn(),
  auditAutoEnrollments: vi.fn(),
}));

vi.mock("@/lib/dean-scope", () => ({
  getDeanDepartmentIds: vi.fn(),
  classDeanWhere: vi.fn((ids: string[]) => ({ program: { departmentId: { in: ids } } })),
  assignmentDeanWhere: vi.fn((ids: string[]) => ({ class: { program: { departmentId: { in: ids } } } })),
}));

vi.mock("@/lib/import/parse", () => ({
  parseSpreadsheet: vi.fn(),
  assertFileSize: vi.fn(),
  assertRowCount: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    semester: { findMany: vi.fn() },
    program: { findMany: vi.fn() },
    class: { findMany: vi.fn() },
    course: { findMany: vi.fn() },
    lecturer: { findMany: vi.fn() },
    classCoursePlan: { findMany: vi.fn() },
    lecturerCourseAssignment: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
  BULK_TRANSACTION_OPTIONS: { timeout: 30000, maxWait: 10000 },
}));

import { requirePermission, getUserAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import { parseSpreadsheet } from "@/lib/import/parse";
import { autoEnrollClassIntoAssignment, auditAutoEnrollments } from "@/lib/enrollment";
import {
  previewWorkloadImport,
  confirmWorkloadImport,
  getPendingAutoTimetableAssignments,
} from "./actions";

function mockRoles(roleNames: string[]) {
  vi.mocked(getUserAccess).mockResolvedValue({ permissions: new Set(), roleNames } as never);
}

const semester = {
  id: "sem-1",
  name: "Semester 1",
  isActive: true,
  academicYear: { name: "2026-2027" },
};

const program = { id: "prog-1", code: "CMS", name: "Computer & Mgmt Sciences" };

const classRow = {
  id: "class-1",
  name: "CMS26-A-FT",
  programId: "prog-1",
  program,
  currentSemesterNumber: 3,
  studyMode: "FT",
  roomId: "room-1",
  room: { name: "Room 101", campus: { name: "Main Campus" } },
};

const course = { id: "course-1", name: "Databases", code: "CS201" };

const lecturer = {
  id: "lect-1",
  staffNo: "S1001",
  fullName: "Dr. Ahmed",
};

function fakeFile(): File {
  return new File(["dummy"], "workload.xlsx");
}

async function formDataWith(file: File) {
  const fd = new FormData();
  fd.set("file", file);
  return fd;
}

describe("previewWorkloadImport", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.semester.findMany).mockResolvedValue([semester] as never);
    vi.mocked(prisma.program.findMany).mockResolvedValue([program] as never);
    vi.mocked(prisma.class.findMany).mockResolvedValue([classRow] as never);
    vi.mocked(prisma.course.findMany).mockResolvedValue([course] as never);
    vi.mocked(prisma.lecturer.findMany).mockResolvedValue([lecturer] as never);
    vi.mocked(prisma.classCoursePlan.findMany).mockResolvedValue([
      { classId: "class-1", semesterNumber: 3, courseId: "course-1" },
    ] as never);
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([]);
  });

  function row(overrides: Record<string, string> = {}) {
    return {
      rowNumber: 1,
      cells: {
        semester: "Semester 1",
        program: "CMS",
        class: "CMS26-A-FT",
        course: "CS201",
        lecturer: "S1001",
        credit_hours: "3",
        ...overrides,
      },
    };
  }

  it("enforces the workload.import permission before reading anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(previewWorkloadImport(await formDataWith(fakeFile()))).rejects.toThrow("FORBIDDEN");
    expect(prisma.semester.findMany).not.toHaveBeenCalled();
  });

  it("marks a fully valid row as OK, carrying the class's default room through", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({ rows: [row()] });
    const result = await previewWorkloadImport(await formDataWith(fakeFile()));
    expect(result.counts.ok).toBe(1);
    expect(result.rows[0].status).toBe("OK");
    expect(result.rows[0].data).toMatchObject({
      classId: "class-1",
      courseId: "course-1",
      lecturerId: "lect-1",
      creditHours: 3,
      classRoomId: "room-1",
      classRoomLabel: "Room 101 — Main Campus",
    });
  });

  it("carries a null classRoomId/classRoomLabel through for a class with no room set", async () => {
    vi.mocked(prisma.class.findMany).mockResolvedValue([
      { ...classRow, roomId: null, room: null },
    ] as never);
    vi.mocked(parseSpreadsheet).mockReturnValue({ rows: [row()] });
    const result = await previewWorkloadImport(await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("OK");
    expect(result.rows[0].data).toMatchObject({ classRoomId: null, classRoomLabel: null });
  });

  it("flags an unknown class as an ERROR", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({ rows: [row({ class: "NOPE" })] });
    const result = await previewWorkloadImport(await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toMatch(/Unknown class/);
  });

  it("flags a course not in the class's course plan for its current semester level", async () => {
    vi.mocked(prisma.classCoursePlan.findMany).mockResolvedValue([]); // nothing planned
    vi.mocked(parseSpreadsheet).mockReturnValue({ rows: [row()] });
    const result = await previewWorkloadImport(await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toMatch(/not in .* course plan/);
  });

  it("flags an unknown lecturer as an ERROR", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({ rows: [row({ lecturer: "NOBODY" })] });
    const result = await previewWorkloadImport(await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toMatch(/Unknown lecturer/);
  });

  it("flags a non-positive credit_hours as an ERROR", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({ rows: [row({ credit_hours: "0" })] });
    const result = await previewWorkloadImport(await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toMatch(/Invalid credit_hours/);
  });

  it("flags duplicate class+course+semester rows within the same file", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({ rows: [row(), { ...row(), rowNumber: 2 }] });
    const result = await previewWorkloadImport(await formDataWith(fakeFile()));
    expect(result.counts.duplicate).toBe(2);
    expect(result.counts.ok).toBe(0);
  });

  it("marks an existing assignment with the SAME lecturer as ALREADY_EXISTS (harmless no-op)", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      { classId: "class-1", courseId: "course-1", semesterId: "sem-1", lecturerId: "lect-1", lecturer: { fullName: "Dr. Ahmed" } },
    ] as never);
    vi.mocked(parseSpreadsheet).mockReturnValue({ rows: [row()] });
    const result = await previewWorkloadImport(await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("ALREADY_EXISTS");
  });

  it("marks an existing assignment with a DIFFERENT lecturer as an ERROR (conflict), never silently overwritten", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      { classId: "class-1", courseId: "course-1", semesterId: "sem-1", lecturerId: "lect-9", lecturer: { fullName: "Dr. Other" } },
    ] as never);
    vi.mocked(parseSpreadsheet).mockReturnValue({ rows: [row()] });
    const result = await previewWorkloadImport(await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toMatch(/Lecturer conflict.*Dr\. Other/);
  });

  it("scopes the class list to the dean's own faculty — an out-of-scope class is Unknown, not a leak", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["other-dept"]);
    vi.mocked(prisma.class.findMany).mockResolvedValue([]); // dean-scoped query returns nothing
    vi.mocked(parseSpreadsheet).mockReturnValue({ rows: [row()] });
    const result = await previewWorkloadImport(await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toMatch(/Unknown class/);
  });
});

describe("confirmWorkloadImport", () => {
  const okRow = {
    semesterId: "sem-1",
    semesterLabel: "Semester 1 (2026-2027)",
    classId: "class-1",
    className: "CMS26-A-FT",
    classCurrentSemesterNumber: 3,
    studyMode: "FT" as const,
    classRoomId: "room-1",
    classRoomLabel: "Room 101 — Main Campus",
    classPeriod: "MORNING" as const,
    courseId: "course-1",
    courseName: "Databases",
    lecturerId: "lect-1",
    lecturerName: "Dr. Ahmed",
    creditHours: 3,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.class.findMany).mockResolvedValue([{ id: "class-1" }] as never);
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([]);
    vi.mocked(autoEnrollClassIntoAssignment).mockResolvedValue([]);
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) =>
      (fn as (tx: unknown) => unknown)({
        lecturerCourseAssignment: {
          create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: "assign-new", ...data })),
        },
      })
    );
  });

  it("enforces the workload.import permission", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(confirmWorkloadImport([okRow], "file.xlsx")).rejects.toThrow("FORBIDDEN");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("creates the assignment with creditHours and auto-enrolls, in one transaction", async () => {
    const result = await confirmWorkloadImport([okRow], "file.xlsx");
    expect(result.created).toBe(1);
    expect(result.createdAssignments[0]).toMatchObject({ creditHours: 3, classId: "class-1" });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000, maxWait: 10000 });
    expect(autoEnrollClassIntoAssignment).toHaveBeenCalledTimes(1);
  });

  it("re-checks for a conflict right before writing and skips it (race safety)", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      { classId: "class-1", courseId: "course-1", semesterId: "sem-1" },
    ] as never);
    const result = await confirmWorkloadImport([okRow], "file.xlsx");
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("silently drops a row whose class fell out of the caller's dean scope since preview", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["other-dept"]);
    vi.mocked(prisma.class.findMany).mockResolvedValue([]); // class no longer in scope
    const result = await confirmWorkloadImport([okRow], "file.xlsx");
    expect(result.created).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("audits WORKLOAD_IMPORTED with row counts and filename", async () => {
    await confirmWorkloadImport([okRow], "workload.xlsx");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        action: "WORKLOAD_IMPORTED",
        entity: "LecturerCourseAssignment",
        newValue: expect.objectContaining({ fileName: "workload.xlsx", created: 1, skipped: 0 }),
      })
    );
    expect(auditAutoEnrollments).toHaveBeenCalled();
  });
});

describe("getPendingAutoTimetableAssignments", () => {
  const pendingRow = {
    id: "assign-1",
    classId: "class-1",
    semesterId: "sem-1",
    creditHours: 3,
    lecturer: { fullName: "Dr. Ahmed" },
    course: { name: "Databases" },
    class: {
      id: "class-1",
      name: "CMS26-A-FT",
      studyMode: "FT",
      currentSemesterNumber: 3,
      roomId: "room-1",
      room: { name: "Room 101", campus: { name: "Main Campus" } },
    },
    semester: { name: "Semester 1", academicYear: { name: "2026-2027" } },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([pendingRow] as never);
  });

  it("queries only assignments with creditHours set and zero timetable slots", async () => {
    await getPendingAutoTimetableAssignments("user-1");
    expect(prisma.lecturerCourseAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          creditHours: { not: null },
          timetableSlots: { none: {} },
        }),
      })
    );
  });

  it("scopes to the dean's departments when the caller is a DEAN", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-1"]);
    await getPendingAutoTimetableAssignments("user-1");
    expect(prisma.lecturerCourseAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          class: { program: { departmentId: { in: ["dept-1"] } } },
        }),
      })
    );
  });

  it("builds the same CreatedAssignmentSummary shape the success dialog uses", async () => {
    const result = await getPendingAutoTimetableAssignments("user-1");
    expect(result).toEqual([
      {
        assignmentId: "assign-1",
        lecturerName: "Dr. Ahmed",
        courseName: "Databases",
        className: "CMS26-A-FT",
        classId: "class-1",
        semesterId: "sem-1",
        semesterLabel: "Semester 1 (2026-2027)",
        classCurrentSemesterNumber: 3,
        studyMode: "FT",
        classRoomId: "room-1",
        classRoomLabel: "Room 101 — Main Campus",
        creditHours: 3,
      },
    ]);
  });

  it("returns a null classRoomLabel when the class has no room set", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      { ...pendingRow, class: { ...pendingRow.class, roomId: null, room: null } },
    ] as never);
    const result = await getPendingAutoTimetableAssignments("user-1");
    expect(result[0]).toMatchObject({ classRoomId: null, classRoomLabel: null });
  });
});
