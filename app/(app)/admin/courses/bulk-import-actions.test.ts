import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAdmin = { id: "admin-1" };

vi.mock("@/lib/auth", () => ({
  requireRole: vi.fn(),
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
    course: { findMany: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(async (arg) => Promise.all(arg)),
  },
}));

import { requireRole } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { parseSpreadsheet } from "@/lib/import/parse";
import {
  previewCourseImport,
  confirmCourseImport,
} from "./bulk-import-actions";

function fileFormData(): FormData {
  const fd = new FormData();
  fd.set("file", new File(["dummy"], "courses.xlsx"));
  return fd;
}

function row(rowNumber: number, cells: Record<string, string>) {
  return { rowNumber, cells };
}

describe("previewCourseImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireRole).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.course.findMany).mockResolvedValue([]);
  });

  it("marks a valid row as OK and uppercases the code", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [row(1, { course_code: "cs201", course_name: "Data Structures" })],
    });

    const result = await previewCourseImport(fileFormData());

    expect(result.rows[0]).toMatchObject({
      status: "OK",
      data: { code: "CS201", name: "Data Structures" },
    });
  });

  it("flags missing fields", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [row(1, { course_code: "", course_name: "" })],
    });

    const result = await previewCourseImport(fileFormData());

    expect(result.rows[0].status).toBe("ERROR");
    expect(result.rows[0].reason).toContain("Missing course_code");
    expect(result.rows[0].reason).toContain("Missing course_name");
  });

  it("flags every row sharing a duplicate course_code (case-insensitive)", async () => {
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [
        row(1, { course_code: "CS201", course_name: "Data Structures" }),
        row(2, { course_code: "cs201", course_name: "Data Structures II" }),
      ],
    });

    const result = await previewCourseImport(fileFormData());

    expect(result.rows[0].status).toBe("DUPLICATE_IN_FILE");
    expect(result.rows[1].status).toBe("DUPLICATE_IN_FILE");
  });

  it("flags a course_code that already exists in the DB as ALREADY_EXISTS", async () => {
    vi.mocked(prisma.course.findMany).mockResolvedValue([
      { code: "CS201" },
    ] as never);
    vi.mocked(parseSpreadsheet).mockReturnValue({
      rows: [row(1, { course_code: "CS201", course_name: "Data Structures" })],
    });

    const result = await previewCourseImport(fileFormData());

    expect(result.rows[0].status).toBe("ALREADY_EXISTS");
  });
});

describe("confirmCourseImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireRole).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.course.findMany).mockResolvedValue([]);
    vi.mocked(prisma.$transaction).mockImplementation(
      (async (arg: unknown) =>
        Array.isArray(arg) ? Promise.all(arg) : arg) as never
    );
  });

  it("does nothing for an empty row list", async () => {
    const result = await confirmCourseImport([], "courses.xlsx");

    expect(result).toEqual({ created: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("pre-checks for courses that already exist and only creates the rest", async () => {
    vi.mocked(prisma.course.findMany).mockResolvedValue([
      { code: "CS201" },
    ] as never);
    vi.mocked(prisma.course.create).mockResolvedValue({} as never);

    const result = await confirmCourseImport(
      [
        { code: "CS201", name: "Data Structures" },
        { code: "CS202", name: "Web Development II" },
      ],
      "courses.xlsx"
    );

    expect(prisma.course.create).toHaveBeenCalledTimes(1);
    expect(prisma.course.create).toHaveBeenCalledWith({
      data: { code: "CS202", name: "Web Development II" },
    });
    expect(result).toEqual({ created: 1 });
  });

  it("audits BULK_IMPORT with the filename and row counts", async () => {
    vi.mocked(prisma.course.create).mockResolvedValue({} as never);

    await confirmCourseImport(
      [{ code: "CS201", name: "Data Structures" }],
      "courses.xlsx"
    );

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "BULK_IMPORT",
        entity: "Course",
        newValue: expect.objectContaining({
          entityType: "Course",
          fileName: "courses.xlsx",
          created: 1,
        }),
      })
    );
  });
});
