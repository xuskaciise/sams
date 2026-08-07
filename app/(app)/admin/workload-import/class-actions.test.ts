import { describe, it, expect, vi, beforeEach } from "vitest";
import * as XLSX from "xlsx";

const mockUser = { id: "user-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/dean-scope", () => ({
  classDeanWhere: vi.fn((ids: string[]) => ({ program: { departmentId: { in: ids } } })),
}));

vi.mock("@/lib/import/parse", () => ({
  parseSpreadsheet: vi.fn(),
  assertFileSize: vi.fn(),
  assertRowCount: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    class: { findFirst: vi.fn() },
    classCoursePlan: { findMany: vi.fn() },
    semester: { findFirst: vi.fn() },
    lecturer: { findMany: vi.fn() },
    lecturerCourseAssignment: { findMany: vi.fn() },
  },
}));

// class-actions.ts delegates scope resolution and the actual
// creation/audit/summary work to actions.ts — mocked here so this file's
// own logic (class resolution, course-plan-scoped row validation, and how
// it assembles the full WorkloadImportRow before handing off) is tested in
// isolation. finalizeWorkloadImport's own transaction/audit behavior is
// already covered by actions.test.ts.
vi.mock("./actions", () => ({
  getScopeFlags: vi.fn(),
  finalizeWorkloadImport: vi.fn(),
}));

import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getScopeFlags, finalizeWorkloadImport } from "./actions";
import {
  downloadClassWorkloadTemplate,
  previewClassWorkloadImport,
  confirmClassWorkloadImport,
} from "./class-actions";

function mockScope(isDean: boolean, departmentIds: string[] = []) {
  vi.mocked(getScopeFlags).mockResolvedValue({ isDean, departmentIds });
}

const classRow = {
  id: "class-1",
  name: "CMS26-A-FT",
  currentSemesterNumber: 3,
  studyMode: "FT",
  roomId: "room-1",
  room: { name: "Room 101", campus: { name: "Main Campus" } },
};

const course1 = { id: "course-1", name: "Databases", code: "CS201" };
const course2 = { id: "course-2", name: "Networking", code: "CS202" };

const lecturer = { id: "lect-1", staffNo: "S1001", fullName: "Dr. Ahmed", availableDays: [] as string[] };

const semester = {
  id: "sem-1",
  name: "Semester 1",
  isActive: true,
  academicYear: { name: "2026-2027" },
};

function fakeFile(): File {
  return new File(["dummy"], "workload.xlsx");
}

async function formDataWith(file: File) {
  const fd = new FormData();
  fd.set("file", file);
  return fd;
}

function row(overrides: Record<string, string> = {}) {
  return {
    rowNumber: 1,
    cells: {
      course_code: "CS201",
      course_name: "Databases",
      lecturer: "S1001",
      credit_hours: "3",
      ...overrides,
    },
  };
}

describe("downloadClassWorkloadTemplate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    mockScope(false);
    vi.mocked(prisma.class.findFirst).mockResolvedValue(classRow as never);
    vi.mocked(prisma.classCoursePlan.findMany).mockResolvedValue([
      { classId: "class-1", semesterNumber: 3, courseId: "course-1", course: course1 },
      { classId: "class-1", semesterNumber: 3, courseId: "course-2", course: course2 },
    ] as never);
  });

  it("enforces workload.import before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(downloadClassWorkloadTemplate("class-1")).rejects.toThrow("FORBIDDEN");
    expect(prisma.class.findFirst).not.toHaveBeenCalled();
  });

  it("throws CLASS_NOT_FOUND for a class outside the caller's scope", async () => {
    vi.mocked(prisma.class.findFirst).mockResolvedValue(null);
    await expect(downloadClassWorkloadTemplate("class-1")).rejects.toThrow("CLASS_NOT_FOUND");
  });

  it("throws CLASS_NO_SEMESTER_LEVEL for a class with no current level set", async () => {
    vi.mocked(prisma.class.findFirst).mockResolvedValue({
      ...classRow,
      currentSemesterNumber: null,
    } as never);
    await expect(downloadClassWorkloadTemplate("class-1")).rejects.toThrow(
      "CLASS_NO_SEMESTER_LEVEL"
    );
  });

  it("throws CLASS_NO_COURSE_PLAN when the class's current level has zero planned courses", async () => {
    vi.mocked(prisma.classCoursePlan.findMany).mockResolvedValue([]);
    await expect(downloadClassWorkloadTemplate("class-1")).rejects.toThrow(
      "CLASS_NO_COURSE_PLAN"
    );
  });

  it("builds a template with one row per planned course, code+name pre-filled, lecturer+credit_hours blank", async () => {
    const { base64, fileName } = await downloadClassWorkloadTemplate("class-1");
    expect(fileName).toBe("workload-CMS26-A-FT-semester3.xlsx");

    const workbook = XLSX.read(Buffer.from(base64, "base64"), { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as string[][];

    expect(data[0]).toEqual(["course_code", "course_name", "lecturer", "credit_hours"]);
    expect(data[1]).toEqual(["CS201", "Databases", "", ""]);
    expect(data[2]).toEqual(["CS202", "Networking", "", ""]);
  });
});

describe("previewClassWorkloadImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    mockScope(false);
    vi.mocked(prisma.class.findFirst).mockResolvedValue(classRow as never);
    vi.mocked(prisma.semester.findFirst).mockResolvedValue(semester as never);
    vi.mocked(prisma.classCoursePlan.findMany).mockResolvedValue([
      { classId: "class-1", semesterNumber: 3, courseId: "course-1", course: course1 },
    ] as never);
    vi.mocked(prisma.lecturer.findMany).mockResolvedValue([lecturer] as never);
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([]);
  });

  it("enforces workload.import before parsing anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(
      previewClassWorkloadImport("class-1", await formDataWith(fakeFile()))
    ).rejects.toThrow("FORBIDDEN");
  });

  it("throws CLASS_NOT_FOUND for an out-of-scope class rather than a row-level error", async () => {
    vi.mocked(prisma.class.findFirst).mockResolvedValue(null);
    await expect(
      previewClassWorkloadImport("class-1", await formDataWith(fakeFile()))
    ).rejects.toThrow("CLASS_NOT_FOUND");
  });

  it("throws NO_ACTIVE_SEMESTER when no semester is currently active", async () => {
    vi.mocked(prisma.semester.findFirst).mockResolvedValue(null);
    await expect(
      previewClassWorkloadImport("class-1", await formDataWith(fakeFile()))
    ).rejects.toThrow("NO_ACTIVE_SEMESTER");
  });

  it("marks a fully valid row as OK, using the course code/name from the plan", async () => {
    const { parseSpreadsheet } = await import("@/lib/import/parse");
    vi.mocked(parseSpreadsheet).mockReturnValue({ rows: [row()] });
    const result = await previewClassWorkloadImport("class-1", await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("OK");
    expect(result.rows[0].data).toEqual({
      courseId: "course-1",
      courseCode: "CS201",
      courseName: "Databases",
      lecturerId: "lect-1",
      lecturerName: "Dr. Ahmed",
      creditHours: 3,
    });
  });

  // The whole point of this flow: a course_code that resolves to a REAL
  // course elsewhere in the system, but isn't in THIS class's plan, must
  // never be silently accepted — same rule as before, just checked
  // against a fixed single class instead of a per-row one.
  it("flags a course_code not in this class's plan as an ERROR, even if it's a real course", async () => {
    const { parseSpreadsheet } = await import("@/lib/import/parse");
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [row({ course_code: "CS202" })],
    });
    const result = await previewClassWorkloadImport("class-1", await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toMatch(/not in this class's course plan/);
  });

  it("flags an unknown course_code as an ERROR", async () => {
    const { parseSpreadsheet } = await import("@/lib/import/parse");
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [row({ course_code: "NOPE" })],
    });
    const result = await previewClassWorkloadImport("class-1", await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toMatch(/not in this class's course plan/);
  });

  it("flags an unknown lecturer as an ERROR", async () => {
    const { parseSpreadsheet } = await import("@/lib/import/parse");
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [row({ lecturer: "NOBODY" })],
    });
    const result = await previewClassWorkloadImport("class-1", await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toMatch(/Unknown lecturer/);
  });

  it("flags a non-positive credit_hours as an ERROR", async () => {
    const { parseSpreadsheet } = await import("@/lib/import/parse");
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [row({ credit_hours: "-1" })],
    });
    const result = await previewClassWorkloadImport("class-1", await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toMatch(/Invalid credit_hours/);
  });

  it("flags every row sharing a duplicate course within the file, not just the 2nd+", async () => {
    const { parseSpreadsheet } = await import("@/lib/import/parse");
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [row(), { ...row(), rowNumber: 2 }],
    });
    const result = await previewClassWorkloadImport("class-1", await formDataWith(fakeFile()));
    expect(result.counts.duplicate).toBe(2);
    expect(result.counts.ok).toBe(0);
  });

  it("marks an existing assignment with the SAME lecturer as ALREADY_EXISTS", async () => {
    const { parseSpreadsheet } = await import("@/lib/import/parse");
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      { courseId: "course-1", lecturerId: "lect-1", lecturer: { fullName: "Dr. Ahmed" } },
    ] as never);
    vi.mocked(parseSpreadsheet).mockReturnValue({ rows: [row()] });
    const result = await previewClassWorkloadImport("class-1", await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("ALREADY_EXISTS");
  });

  it("flags an existing assignment with a DIFFERENT lecturer as a conflict ERROR", async () => {
    const { parseSpreadsheet } = await import("@/lib/import/parse");
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      { courseId: "course-1", lecturerId: "lect-9", lecturer: { fullName: "Dr. Other" } },
    ] as never);
    vi.mocked(parseSpreadsheet).mockReturnValue({ rows: [row()] });
    const result = await previewClassWorkloadImport("class-1", await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toMatch(/Lecturer conflict.*Dr\. Other/);
  });

  it("flags a row as an ERROR when the lecturer's availableDays has ZERO overlap with the class's valid days", async () => {
    vi.mocked(prisma.lecturer.findMany).mockResolvedValue([
      { ...lecturer, availableDays: ["THU", "FRI"] }, // class is FT (Sat-Wed) — never overlaps
    ] as never);
    const { parseSpreadsheet } = await import("@/lib/import/parse");
    vi.mocked(parseSpreadsheet).mockReturnValue({ rows: [row()] });
    const result = await previewClassWorkloadImport("class-1", await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toMatch(/Lecturer is only available Thu\/Fri/);
  });

  it("does NOT flag a row when the lecturer's availableDays has a partial overlap — still schedulable", async () => {
    vi.mocked(prisma.lecturer.findMany).mockResolvedValue([
      { ...lecturer, availableDays: ["SAT"] }, // SAT is a valid FT day
    ] as never);
    const { parseSpreadsheet } = await import("@/lib/import/parse");
    vi.mocked(parseSpreadsheet).mockReturnValue({ rows: [row()] });
    const result = await previewClassWorkloadImport("class-1", await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("OK");
  });

  it("scopes the class lookup to the dean's own faculty", async () => {
    mockScope(true, ["dept-cs"]);
    vi.mocked(prisma.class.findFirst).mockResolvedValue(classRow as never);
    const { parseSpreadsheet } = await import("@/lib/import/parse");
    vi.mocked(parseSpreadsheet).mockReturnValue({ rows: [row()] });
    await previewClassWorkloadImport("class-1", await formDataWith(fakeFile()));
    expect(prisma.class.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "class-1",
          program: { departmentId: { in: ["dept-cs"] } },
        }),
      })
    );
  });
});

describe("confirmClassWorkloadImport", () => {
  const okRow = {
    courseId: "course-1",
    courseCode: "CS201",
    courseName: "Databases",
    lecturerId: "lect-1",
    lecturerName: "Dr. Ahmed",
    creditHours: 3,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    mockScope(false);
    vi.mocked(prisma.class.findFirst).mockResolvedValue(classRow as never);
    vi.mocked(prisma.semester.findFirst).mockResolvedValue(semester as never);
    vi.mocked(prisma.lecturer.findMany).mockResolvedValue([lecturer] as never);
    vi.mocked(finalizeWorkloadImport).mockResolvedValue({
      created: 1,
      skipped: 0,
      errorsInFile: 0,
      createdAssignments: [],
    });
  });

  it("enforces workload.import before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(confirmClassWorkloadImport("class-1", [okRow], "file.xlsx")).rejects.toThrow(
      "FORBIDDEN"
    );
    expect(finalizeWorkloadImport).not.toHaveBeenCalled();
  });

  it("throws CLASS_NOT_FOUND if the class fell out of scope since preview", async () => {
    vi.mocked(prisma.class.findFirst).mockResolvedValue(null);
    await expect(confirmClassWorkloadImport("class-1", [okRow], "file.xlsx")).rejects.toThrow(
      "CLASS_NOT_FOUND"
    );
    expect(finalizeWorkloadImport).not.toHaveBeenCalled();
  });

  it("builds the full WorkloadImportRow shape from the resolved class + active semester and delegates to finalizeWorkloadImport", async () => {
    await confirmClassWorkloadImport("class-1", [okRow], "workload.xlsx", 2);

    expect(finalizeWorkloadImport).toHaveBeenCalledWith(
      "user-1",
      [
        {
          semesterId: "sem-1",
          semesterLabel: "Semester 1 (2026-2027)",
          classId: "class-1",
          className: "CMS26-A-FT",
          classCurrentSemesterNumber: 3,
          studyMode: "FT",
          classRoomId: "room-1",
          classRoomLabel: "Room 101 — Main Campus",
          courseId: "course-1",
          courseName: "Databases",
          lecturerId: "lect-1",
          lecturerName: "Dr. Ahmed",
          lecturerAvailableDays: [],
          creditHours: 3,
        },
      ],
      1,
      "workload.xlsx",
      2
    );
  });

  it("carries a fresh availableDays lookup through to the assembled row, not the round-tripped one", async () => {
    vi.mocked(prisma.lecturer.findMany).mockResolvedValue([
      { ...lecturer, availableDays: ["SAT", "WED"] },
    ] as never);

    await confirmClassWorkloadImport("class-1", [okRow], "workload.xlsx");

    expect(finalizeWorkloadImport).toHaveBeenCalledWith(
      "user-1",
      expect.arrayContaining([expect.objectContaining({ lecturerAvailableDays: ["SAT", "WED"] })]),
      1,
      "workload.xlsx",
      0
    );
  });

  it("delegates an empty row list straight to finalizeWorkloadImport without resolving a semester", async () => {
    await confirmClassWorkloadImport("class-1", [], "workload.xlsx");
    expect(finalizeWorkloadImport).toHaveBeenCalledWith("user-1", [], 0, "workload.xlsx", 0);
    expect(prisma.semester.findFirst).not.toHaveBeenCalled();
  });
});
