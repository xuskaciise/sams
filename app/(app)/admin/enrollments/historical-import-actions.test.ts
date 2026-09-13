import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAdmin = { id: "admin-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/import/parse", () => ({
  parseSpreadsheet: vi.fn(),
  assertFileSize: vi.fn(),
  assertRowCount: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    student: { findMany: vi.fn() },
    course: { findMany: vi.fn() },
    academicYear: { findMany: vi.fn() },
    semester: { findMany: vi.fn() },
    studentCourseEnrollment: { findMany: vi.fn(), createMany: vi.fn() },
  },
}));

import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { parseSpreadsheet } from "@/lib/import/parse";
import {
  previewHistoricalEnrollmentImport,
  confirmHistoricalEnrollmentImport,
} from "./historical-import-actions";

function fileFormData(): FormData {
  const fd = new FormData();
  fd.set("file", new File(["dummy"], "historical.xlsx"));
  return fd;
}

function row(rowNumber: number, cells: Record<string, string>) {
  return { rowNumber, cells };
}

const student = { id: "student-1", studentNo: "S1001", classId: "class-1" };
const course = { id: "course-1", code: "CS101" };
const year = { id: "year-1", name: "2022-2023" };
// Level 1 (odd) -> Semester 1; level 2 (even) -> Semester 2.
const semester1 = { id: "sem-1", academicYearId: "year-1", semesterNumber: 1 };
const semester2 = { id: "sem-2", academicYearId: "year-1", semesterNumber: 2 };

describe("previewHistoricalEnrollmentImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.student.findMany).mockResolvedValue([student] as never);
    vi.mocked(prisma.course.findMany).mockResolvedValue([course] as never);
    vi.mocked(prisma.academicYear.findMany).mockResolvedValue([year] as never);
    vi.mocked(prisma.semester.findMany).mockResolvedValue([
      semester1,
      semester2,
    ] as never);
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([]);
  });

  it("enforces enrollments.manage before parsing anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(previewHistoricalEnrollmentImport(fileFormData())).rejects.toThrow(
      "FORBIDDEN"
    );
    expect(parseSpreadsheet).not.toHaveBeenCalled();
  });

  it("marks a fully valid odd-level row OK, resolving it to Semester 1 and the student's current class", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, {
          student_no: "S1001",
          course_code: "CS101",
          semester_level: "1",
          year: "2022-2023",
        }),
      ],
    });

    const result = await previewHistoricalEnrollmentImport(fileFormData());

    expect(result.counts).toEqual({ ok: 1, duplicate: 0, alreadyExists: 0, error: 0 });
    expect(result.rows[0]).toMatchObject({
      status: "OK",
      data: {
        studentId: "student-1",
        courseId: "course-1",
        classId: "class-1",
        semesterId: "sem-1",
      },
    });
  });

  it("resolves an even level to that year's Semester 2, not Semester 1", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, {
          student_no: "S1001",
          course_code: "CS101",
          semester_level: "2",
          year: "2022-2023",
        }),
      ],
    });

    const result = await previewHistoricalEnrollmentImport(fileFormData());

    expect(result.rows[0]).toMatchObject({
      status: "OK",
      data: { semesterId: "sem-2" },
    });
  });

  it("flags an unknown student_no with the exact reason", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, {
          student_no: "GHOST",
          course_code: "CS101",
          semester_level: "1",
          year: "2022-2023",
        }),
      ],
    });

    const result = await previewHistoricalEnrollmentImport(fileFormData());

    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toContain('Unknown student_no "GHOST"');
  });

  it("flags an unknown course_code with the exact reason", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, {
          student_no: "S1001",
          course_code: "MISSING",
          semester_level: "1",
          year: "2022-2023",
        }),
      ],
    });

    const result = await previewHistoricalEnrollmentImport(fileFormData());

    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toContain('Unknown course_code "MISSING"');
  });

  it.each(["0", "9", "abc", "3.5"])(
    "flags an invalid semester_level %s (expected a whole number 1-8)",
    async (badLevel) => {
      vi.mocked(parseSpreadsheet).mockReturnValue({
        rows: [
          row(1, {
            student_no: "S1001",
            course_code: "CS101",
            semester_level: badLevel,
            year: "2022-2023",
          }),
        ],
      });

      const result = await previewHistoricalEnrollmentImport(fileFormData());

      expect(result.rows[0].status).toBe("ERROR");
      expect(result.rows[0].reason).toContain("Invalid semester_level");
    }
  );

  it("flags an unknown academic year with the exact reason", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, {
          student_no: "S1001",
          course_code: "CS101",
          semester_level: "1",
          year: "1999-2000",
        }),
      ],
    });

    const result = await previewHistoricalEnrollmentImport(fileFormData());

    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toContain('Unknown academic year "1999-2000"');
  });

  it("flags a real year with no matching Semester record — never guesses/creates one", async () => {
    vi.mocked(prisma.semester.findMany).mockResolvedValue([semester1] as never); // no Semester 2 for this year
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, {
          student_no: "S1001",
          course_code: "CS101",
          semester_level: "2", // even -> needs Semester 2
          year: "2022-2023",
        }),
      ],
    });

    const result = await previewHistoricalEnrollmentImport(fileFormData());

    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toContain("No Semester 2 record exists");
    expect(result.rows[0].data).toBeNull();
  });

  it("flags a row whose exact student+course+semester enrollment already exists — skipped, not duplicated", async () => {
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([
      { studentId: "student-1", courseId: "course-1", semesterId: "sem-1" },
    ] as never);
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, {
          student_no: "S1001",
          course_code: "CS101",
          semester_level: "1",
          year: "2022-2023",
        }),
      ],
    });

    const result = await previewHistoricalEnrollmentImport(fileFormData());

    expect(result.rows[0].status).toBe("ALREADY_EXISTS");
  });

  it("flags every row sharing a key as DUPLICATE_IN_FILE, not just the 2nd occurrence", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, {
          student_no: "S1001",
          course_code: "CS101",
          semester_level: "1",
          year: "2022-2023",
        }),
        row(2, {
          student_no: "S1001",
          course_code: "CS101",
          semester_level: "1",
          year: "2022-2023",
        }),
      ],
    });

    const result = await previewHistoricalEnrollmentImport(fileFormData());

    expect(result.rows[0].status).toBe("DUPLICATE_IN_FILE");
    expect(result.rows[1].status).toBe("DUPLICATE_IN_FILE");
  });
});

describe("confirmHistoricalEnrollmentImport", () => {
  const validRow = {
    studentId: "student-1",
    courseId: "course-1",
    classId: "class-1",
    semesterId: "sem-1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([]);
    vi.mocked(prisma.semester.findMany).mockResolvedValue([
      { id: "sem-1", startDate: new Date("2022-09-01") },
    ] as never);
  });

  it("enforces enrollments.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(
      confirmHistoricalEnrollmentImport([validRow], "historical.xlsx")
    ).rejects.toThrow("FORBIDDEN");
    expect(prisma.studentCourseEnrollment.createMany).not.toHaveBeenCalled();
  });

  it("creates a COMPLETED enrollment backdated to the semester's own startDate — never 'now'", async () => {
    await confirmHistoricalEnrollmentImport([validRow], "historical.xlsx");

    expect(prisma.studentCourseEnrollment.createMany).toHaveBeenCalledWith({
      data: [
        {
          studentId: "student-1",
          courseId: "course-1",
          classId: "class-1",
          semesterId: "sem-1",
          status: "COMPLETED",
          enrolledAt: new Date("2022-09-01"),
        },
      ],
    });
  });

  it("re-checks for an existing (student, course, semester) triple right before writing and skips it", async () => {
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([
      { studentId: "student-1", courseId: "course-1", semesterId: "sem-1" },
    ] as never);

    const result = await confirmHistoricalEnrollmentImport([validRow], "historical.xlsx");

    expect(result).toEqual({ created: 0 });
    expect(prisma.studentCourseEnrollment.createMany).not.toHaveBeenCalled();
  });

  it("is idempotent — re-running the exact same import a second time creates nothing", async () => {
    await confirmHistoricalEnrollmentImport([validRow], "historical.xlsx");

    // Simulate the second run seeing the row that was just created.
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([
      { studentId: "student-1", courseId: "course-1", semesterId: "sem-1" },
    ] as never);
    vi.mocked(prisma.studentCourseEnrollment.createMany).mockClear();

    const secondRun = await confirmHistoricalEnrollmentImport([validRow], "historical.xlsx");

    expect(secondRun).toEqual({ created: 0 });
    expect(prisma.studentCourseEnrollment.createMany).not.toHaveBeenCalled();
  });

  it("audits ONE BULK_IMPORT summary entry with row counts and filename", async () => {
    await confirmHistoricalEnrollmentImport([validRow], "historical.xlsx");

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "BULK_IMPORT",
        entity: "StudentCourseEnrollment",
        newValue: expect.objectContaining({
          entityType: "HistoricalEnrollment",
          fileName: "historical.xlsx",
          requested: 1,
          created: 1,
          skipped: 0,
        }),
      })
    );
  });

  it("returns { created: 0 } without querying when given no rows", async () => {
    const result = await confirmHistoricalEnrollmentImport([], "historical.xlsx");
    expect(result).toEqual({ created: 0 });
    expect(prisma.studentCourseEnrollment.findMany).not.toHaveBeenCalled();
  });
});
