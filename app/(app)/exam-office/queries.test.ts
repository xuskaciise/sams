import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    missedExamRecord: { findMany: vi.fn(), count: vi.fn() },
    specialExamPeriod: { findMany: vi.fn() },
    department: { findMany: vi.fn() },
    course: { findMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import { buildExamOfficeWhere, getExamOfficePanelData } from "./queries";

describe("buildExamOfficeWhere", () => {
  it("is university-wide by construction — no dean/department scope is ever silently added", () => {
    const where = buildExamOfficeWhere({});
    expect(where).toEqual({});
  });

  it("composes every filter, including the faculty (departmentId) and Special Exam Period filters", () => {
    const where = buildExamOfficeWhere({
      specialExamPeriodId: "period-1",
      departmentId: "dept-1",
      courseId: "course-1",
      examType: "FINAL",
      reasonType: "EMERGENCY",
      q: "ali",
    });
    expect(where).toEqual({
      AND: [
        { specialExamPeriodId: "period-1" },
        { enrollment: { courseId: "course-1" } },
        { examType: "FINAL" },
        { reasonType: "EMERGENCY" },
        { enrollment: { class: { program: { departmentId: "dept-1" } } } },
        {
          OR: [
            { student: { fullName: { contains: "ali", mode: "insensitive" } } },
            { student: { studentNo: { contains: "ali", mode: "insensitive" } } },
            {
              enrollment: {
                course: { name: { contains: "ali", mode: "insensitive" } },
              },
            },
          ],
        },
      ],
    });
  });
});

describe("getExamOfficePanelData", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.missedExamRecord.findMany).mockResolvedValue([]);
    vi.mocked(prisma.missedExamRecord.count).mockResolvedValue(0);
    vi.mocked(prisma.specialExamPeriod.findMany).mockResolvedValue([]);
    vi.mocked(prisma.department.findMany).mockResolvedValue([]);
    vi.mocked(prisma.course.findMany).mockResolvedValue([]);
  });

  it("never scopes the record query by department — a faculty filter is only ever an explicit user choice", async () => {
    await getExamOfficePanelData({});

    expect(prisma.missedExamRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} })
    );
    expect(prisma.department.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    });
  });

  it("applies the explicit faculty filter when given, still without any hidden scope", async () => {
    await getExamOfficePanelData({ departmentId: "dept-1" });

    expect(prisma.missedExamRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [{ enrollment: { class: { program: { departmentId: "dept-1" } } } }],
        },
      })
    );
  });

  it("offers every Special Exam Period (not just active ones) — the report is a historical view", async () => {
    await getExamOfficePanelData({});

    expect(prisma.specialExamPeriod.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true, name: true } })
    );
  });
});
