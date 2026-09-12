import { describe, it, expect, vi, beforeEach } from "vitest";
import * as XLSX from "xlsx";

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    missedExamRecord: { findMany: vi.fn(), count: vi.fn() },
  },
}));

import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { exportMissedExamReport } from "./actions";

const record = {
  id: "record-1",
  examType: "MIDTERM",
  reasonType: "ILLNESS",
  reasonNote: "Hospitalized",
  recordedAt: new Date("2026-01-01T10:00:00Z"),
  student: { studentNo: "S1001", fullName: "Jane Doe" },
  course: { name: "Databases", code: "CS201" },
  assignment: {
    class: {
      name: "CMS26-A-FT",
      currentSemesterNumber: 3,
      program: { department: { name: "Computer Science" } },
    },
  },
  semester: { name: "Semester 1", academicYear: { name: "2025-2026" } },
  recordedBy: { fullName: "Admin User" },
};

describe("exportMissedExamReport", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue({ id: "user-1" } as never);
    vi.mocked(prisma.missedExamRecord.findMany).mockResolvedValue([record] as never);
    vi.mocked(prisma.missedExamRecord.count).mockResolvedValue(1);
  });

  it("enforces exam.records.view", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(exportMissedExamReport({})).rejects.toThrow("FORBIDDEN");
    expect(prisma.missedExamRecord.findMany).not.toHaveBeenCalled();
  });

  it("builds a real xlsx workbook whose rows round-trip through XLSX.read", async () => {
    const { base64, fileName } = await exportMissedExamReport({});
    expect(fileName).toBe("Missed_Exam_Records.xlsx");

    const workbook = XLSX.read(Buffer.from(base64, "base64"), { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];

    expect(rows[0]).toEqual([
      "Student No",
      "Student Name",
      "Faculty",
      "Course",
      "Class",
      "Semester",
      "Exam Type",
      "Reason",
      "Note",
      "Recorded By",
      "Recorded At",
    ]);
    expect(rows[1]).toEqual([
      "S1001",
      "Jane Doe",
      "Computer Science",
      "Databases (CS201)",
      "CMS26-A-FT (Semester 3)",
      "Semester 1 (2025-2026)",
      "Midterm",
      "Illness",
      "Hospitalized",
      "Admin User",
      record.recordedAt.toLocaleString(),
    ]);
  });
});
