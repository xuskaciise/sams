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
    class: { findMany: vi.fn() },
    classCoursePlan: { findMany: vi.fn() },
    semester: { findFirst: vi.fn() },
    lecturer: { findMany: vi.fn() },
    lecturerCourseAssignment: { findMany: vi.fn() },
  },
}));

// semester-actions.ts delegates scope resolution and the actual
// creation/audit/summary work to actions.ts — mocked here so this file's
// own logic (candidate-class resolution, course-plan-scoped row
// validation across multiple classes, and how it assembles the full
// WorkloadImportRow before handing off) is tested in isolation.
// finalizeWorkloadImport's own transaction/audit behavior is already
// covered by actions.test.ts.
vi.mock("./actions", () => ({
  getScopeFlags: vi.fn(),
  finalizeWorkloadImport: vi.fn(),
}));

import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getScopeFlags, finalizeWorkloadImport } from "./actions";
import {
  downloadSemesterWorkloadTemplate,
  previewSemesterWorkloadImport,
  confirmSemesterWorkloadImport,
} from "./semester-actions";

function mockScope(isDean: boolean, departmentIds: string[] = []) {
  vi.mocked(getScopeFlags).mockResolvedValue({ isDean, departmentIds });
}

const classA = {
  id: "class-a",
  name: "CMS26-A-FT",
  currentSemesterNumber: 1,
  studyMode: "FT",
  roomId: "room-1",
  room: { name: "Room 101", campus: { name: "Main Campus" } },
};
const classB = {
  id: "class-b",
  name: "CMS26-B-FT",
  currentSemesterNumber: 3,
  studyMode: "FT",
  roomId: "room-2",
  room: { name: "Room 102", campus: { name: "Main Campus" } },
};

const course1 = { id: "course-1", name: "Databases", code: "CS201" };
const course2 = { id: "course-2", name: "Algorithms", code: "CS301" };

const lecturer = { id: "lect-1", staffNo: "S1001", fullName: "Dr. Ahmed" };

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
      semester_level: "1",
      class: "CMS26-A-FT",
      course_code: "CS201",
      course_name: "Databases",
      lecturer: "S1001",
      credit_hours: "3",
      ...overrides,
    },
  };
}

describe("downloadSemesterWorkloadTemplate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    mockScope(false);
    vi.mocked(prisma.class.findMany).mockResolvedValue([classA, classB] as never);
    vi.mocked(prisma.classCoursePlan.findMany).mockResolvedValue([
      { classId: "class-a", semesterNumber: 1, courseId: "course-1", course: course1 },
      { classId: "class-b", semesterNumber: 3, courseId: "course-2", course: course2 },
    ] as never);
  });

  it("enforces workload.import before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(downloadSemesterWorkloadTemplate([1, 3])).rejects.toThrow("FORBIDDEN");
    expect(prisma.class.findMany).not.toHaveBeenCalled();
  });

  it("throws NO_SEMESTER_NUMBERS_SELECTED for an empty selection", async () => {
    await expect(downloadSemesterWorkloadTemplate([])).rejects.toThrow(
      "NO_SEMESTER_NUMBERS_SELECTED"
    );
    expect(prisma.class.findMany).not.toHaveBeenCalled();
  });

  it("throws NO_CLASSES_FOUND when no class is currently at any selected level", async () => {
    vi.mocked(prisma.class.findMany).mockResolvedValue([]);
    await expect(downloadSemesterWorkloadTemplate([1, 3])).rejects.toThrow("NO_CLASSES_FOUND");
  });

  it("throws NO_COURSE_PLANS_FOUND when the resolved classes have no planned courses", async () => {
    vi.mocked(prisma.classCoursePlan.findMany).mockResolvedValue([]);
    await expect(downloadSemesterWorkloadTemplate([1, 3])).rejects.toThrow(
      "NO_COURSE_PLANS_FOUND"
    );
  });

  it("builds one row per (class, course) across every selected level, code+name pre-filled, lecturer+credit_hours blank", async () => {
    const { base64, fileName } = await downloadSemesterWorkloadTemplate([1, 3]);
    expect(fileName).toBe("workload-semesters-1-3.xlsx");

    const workbook = XLSX.read(Buffer.from(base64, "base64"), { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as string[][];

    expect(data[0]).toEqual([
      "semester_level",
      "class",
      "course_code",
      "course_name",
      "lecturer",
      "credit_hours",
    ]);
    expect(data[1]).toEqual(["1", "CMS26-A-FT", "CS201", "Databases", "", ""]);
    expect(data[2]).toEqual(["3", "CMS26-B-FT", "CS301", "Algorithms", "", ""]);
  });

  // The exact edge case this function's own comment calls out: a class's
  // plan row filed under a level that ISN'T that class's own current
  // level (even if that other level happens to also be selected) must
  // never leak into the template.
  it("never includes a class's plan row from a level other than its OWN current level", async () => {
    vi.mocked(prisma.classCoursePlan.findMany).mockResolvedValue([
      { classId: "class-a", semesterNumber: 1, courseId: "course-1", course: course1 },
      // class-a's OWN level is 1, but it also has a stray plan row filed
      // under level 3 (also selected) — must be excluded.
      { classId: "class-a", semesterNumber: 3, courseId: "course-2", course: course2 },
    ] as never);
    const { base64 } = await downloadSemesterWorkloadTemplate([1, 3]);
    const workbook = XLSX.read(Buffer.from(base64, "base64"), { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as string[][];
    expect(data.length).toBe(2); // header + exactly one row
    expect(data[1][2]).toBe("CS201");
  });
});

describe("previewSemesterWorkloadImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    mockScope(false);
    vi.mocked(prisma.class.findMany).mockResolvedValue([classA, classB] as never);
    vi.mocked(prisma.semester.findFirst).mockResolvedValue(semester as never);
    vi.mocked(prisma.classCoursePlan.findMany).mockResolvedValue([
      { classId: "class-a", semesterNumber: 1, courseId: "course-1", course: course1 },
      { classId: "class-b", semesterNumber: 3, courseId: "course-2", course: course2 },
    ] as never);
    vi.mocked(prisma.lecturer.findMany).mockResolvedValue([lecturer] as never);
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([]);
  });

  it("enforces workload.import before parsing anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(
      previewSemesterWorkloadImport([1, 3], await formDataWith(fakeFile()))
    ).rejects.toThrow("FORBIDDEN");
  });

  it("throws NO_SEMESTER_NUMBERS_SELECTED for an empty selection", async () => {
    await expect(
      previewSemesterWorkloadImport([], await formDataWith(fakeFile()))
    ).rejects.toThrow("NO_SEMESTER_NUMBERS_SELECTED");
  });

  it("throws NO_ACTIVE_SEMESTER when no semester is currently active", async () => {
    vi.mocked(prisma.semester.findFirst).mockResolvedValue(null);
    await expect(
      previewSemesterWorkloadImport([1, 3], await formDataWith(fakeFile()))
    ).rejects.toThrow("NO_ACTIVE_SEMESTER");
  });

  it("marks a fully valid row as OK, resolving both class and course from the candidate set", async () => {
    const { parseSpreadsheet } = await import("@/lib/import/parse");
    vi.mocked(parseSpreadsheet).mockReturnValue({ rows: [row()] });
    const result = await previewSemesterWorkloadImport([1, 3], await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("OK");
    expect(result.rows[0].data).toEqual({
      classId: "class-a",
      className: "CMS26-A-FT",
      classCurrentSemesterNumber: 1,
      courseId: "course-1",
      courseCode: "CS201",
      courseName: "Databases",
      lecturerId: "lect-1",
      lecturerName: "Dr. Ahmed",
      creditHours: 3,
    });
  });

  it("marks rows OK across DIFFERENT classes at different selected levels in the same file", async () => {
    const { parseSpreadsheet } = await import("@/lib/import/parse");
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(),
        {
          ...row({
            semester_level: "3",
            class: "CMS26-B-FT",
            course_code: "CS301",
            course_name: "Algorithms",
          }),
          rowNumber: 2,
        },
      ],
    });
    const result = await previewSemesterWorkloadImport([1, 3], await formDataWith(fakeFile()));
    expect(result.counts.ok).toBe(2);
    expect(result.rows[0].data?.classId).toBe("class-a");
    expect(result.rows[1].data?.classId).toBe("class-b");
  });

  it("flags a class not among the selected semester levels as an ERROR", async () => {
    const { parseSpreadsheet } = await import("@/lib/import/parse");
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [row({ class: "SomeOtherClass" })],
    });
    const result = await previewSemesterWorkloadImport([1, 3], await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toMatch(/not among the selected semester levels/);
  });

  // The core guarantee this whole flow rests on: a course_code that
  // resolves to a REAL course, but not in THIS row's class's own plan
  // (even if it's in a DIFFERENT selected class's plan), must never be
  // silently accepted.
  it("flags a course_code belonging to a DIFFERENT class's plan as an ERROR", async () => {
    const { parseSpreadsheet } = await import("@/lib/import/parse");
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [row({ course_code: "CS301" })], // CS301 belongs to class-b's plan, not class-a's
    });
    const result = await previewSemesterWorkloadImport([1, 3], await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toMatch(/not in "CMS26-A-FT"'s course plan/);
  });

  it("flags an unknown lecturer as an ERROR", async () => {
    const { parseSpreadsheet } = await import("@/lib/import/parse");
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [row({ lecturer: "NOBODY" })],
    });
    const result = await previewSemesterWorkloadImport([1, 3], await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toMatch(/Unknown lecturer/);
  });

  it("flags a non-positive credit_hours as an ERROR", async () => {
    const { parseSpreadsheet } = await import("@/lib/import/parse");
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [row({ credit_hours: "0" })],
    });
    const result = await previewSemesterWorkloadImport([1, 3], await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toMatch(/Invalid credit_hours/);
  });

  it("flags every row sharing a duplicate (class, course) pair within the file", async () => {
    const { parseSpreadsheet } = await import("@/lib/import/parse");
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [row(), { ...row(), rowNumber: 2 }],
    });
    const result = await previewSemesterWorkloadImport([1, 3], await formDataWith(fakeFile()));
    expect(result.counts.duplicate).toBe(2);
    expect(result.counts.ok).toBe(0);
  });

  it("marks an existing assignment with the SAME lecturer as ALREADY_EXISTS", async () => {
    const { parseSpreadsheet } = await import("@/lib/import/parse");
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      { classId: "class-a", courseId: "course-1", lecturerId: "lect-1", lecturer: { fullName: "Dr. Ahmed" } },
    ] as never);
    vi.mocked(parseSpreadsheet).mockReturnValue({ rows: [row()] });
    const result = await previewSemesterWorkloadImport([1, 3], await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("ALREADY_EXISTS");
  });

  it("flags an existing assignment with a DIFFERENT lecturer as a conflict ERROR", async () => {
    const { parseSpreadsheet } = await import("@/lib/import/parse");
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      { classId: "class-a", courseId: "course-1", lecturerId: "lect-9", lecturer: { fullName: "Dr. Other" } },
    ] as never);
    vi.mocked(parseSpreadsheet).mockReturnValue({ rows: [row()] });
    const result = await previewSemesterWorkloadImport([1, 3], await formDataWith(fakeFile()));
    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toMatch(/Lecturer conflict.*Dr\. Other/);
  });

  it("scopes the candidate class list to the dean's own faculty", async () => {
    mockScope(true, ["dept-cs"]);
    const { parseSpreadsheet } = await import("@/lib/import/parse");
    vi.mocked(parseSpreadsheet).mockReturnValue({ rows: [row()] });
    await previewSemesterWorkloadImport([1, 3], await formDataWith(fakeFile()));
    expect(prisma.class.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          currentSemesterNumber: { in: [1, 3] },
          program: { departmentId: { in: ["dept-cs"] } },
        }),
      })
    );
  });
});

describe("confirmSemesterWorkloadImport", () => {
  const okRowA = {
    classId: "class-a",
    className: "CMS26-A-FT",
    classCurrentSemesterNumber: 1,
    courseId: "course-1",
    courseCode: "CS201",
    courseName: "Databases",
    lecturerId: "lect-1",
    lecturerName: "Dr. Ahmed",
    creditHours: 3,
  };
  const okRowB = {
    classId: "class-b",
    className: "CMS26-B-FT",
    classCurrentSemesterNumber: 3,
    courseId: "course-2",
    courseCode: "CS301",
    courseName: "Algorithms",
    lecturerId: "lect-1",
    lecturerName: "Dr. Ahmed",
    creditHours: 2,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    mockScope(false);
    vi.mocked(prisma.class.findMany).mockResolvedValue([classA, classB] as never);
    vi.mocked(prisma.semester.findFirst).mockResolvedValue(semester as never);
    vi.mocked(finalizeWorkloadImport).mockResolvedValue({
      created: 2,
      skipped: 0,
      errorsInFile: 0,
      createdAssignments: [],
    });
  });

  it("enforces workload.import before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(
      confirmSemesterWorkloadImport([1, 3], [okRowA, okRowB], "file.xlsx")
    ).rejects.toThrow("FORBIDDEN");
    expect(finalizeWorkloadImport).not.toHaveBeenCalled();
  });

  // Mirrors Bulk Assign / the old bulk workload flow's own convention:
  // a row whose class fell out of scope since preview is silently
  // dropped, not thrown — the rest of the batch (potentially many other
  // classes) should still go through.
  it("silently drops rows whose class fell out of scope since preview, keeping the rest", async () => {
    vi.mocked(prisma.class.findMany).mockResolvedValue([classA] as never); // class-b no longer resolves
    await confirmSemesterWorkloadImport([1, 3], [okRowA, okRowB], "file.xlsx");
    expect(finalizeWorkloadImport).toHaveBeenCalledWith(
      "user-1",
      [expect.objectContaining({ classId: "class-a" })],
      2,
      "file.xlsx",
      0
    );
  });

  it("builds the full WorkloadImportRow shape for each class in the batch and delegates to finalizeWorkloadImport", async () => {
    await confirmSemesterWorkloadImport([1, 3], [okRowA, okRowB], "workload.xlsx", 1);

    expect(finalizeWorkloadImport).toHaveBeenCalledWith(
      "user-1",
      [
        {
          semesterId: "sem-1",
          semesterLabel: "Semester 1 (2026-2027)",
          classId: "class-a",
          className: "CMS26-A-FT",
          classCurrentSemesterNumber: 1,
          studyMode: "FT",
          classRoomId: "room-1",
          classRoomLabel: "Room 101 — Main Campus",
          courseId: "course-1",
          courseName: "Databases",
          lecturerId: "lect-1",
          lecturerName: "Dr. Ahmed",
          creditHours: 3,
        },
        {
          semesterId: "sem-1",
          semesterLabel: "Semester 1 (2026-2027)",
          classId: "class-b",
          className: "CMS26-B-FT",
          classCurrentSemesterNumber: 3,
          studyMode: "FT",
          classRoomId: "room-2",
          classRoomLabel: "Room 102 — Main Campus",
          courseId: "course-2",
          courseName: "Algorithms",
          lecturerId: "lect-1",
          lecturerName: "Dr. Ahmed",
          creditHours: 2,
        },
      ],
      2,
      "workload.xlsx",
      1
    );
  });

  it("delegates an empty row list straight to finalizeWorkloadImport without resolving a semester", async () => {
    await confirmSemesterWorkloadImport([1, 3], [], "workload.xlsx");
    expect(finalizeWorkloadImport).toHaveBeenCalledWith("user-1", [], 0, "workload.xlsx", 0);
    expect(prisma.semester.findFirst).not.toHaveBeenCalled();
  });
});
