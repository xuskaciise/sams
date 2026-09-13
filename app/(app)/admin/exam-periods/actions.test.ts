import { describe, it, expect, vi, beforeEach } from "vitest";

const mockUser = { id: "admin-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    semester: { findUnique: vi.fn() },
    specialExamPeriod: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
}));

import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { createSpecialExamPeriod, setSpecialExamPeriodActive } from "./actions";

const semester = {
  id: "sem-1",
  name: "Semester 1",
  academicYearId: "ay-1",
  academicYear: { id: "ay-1", name: "2026-2027" },
};

describe("createSpecialExamPeriod", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.semester.findUnique).mockResolvedValue(semester as never);
    vi.mocked(prisma.specialExamPeriod.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.specialExamPeriod.create).mockResolvedValue({
      id: "period-1",
      name: "2026-2027 — Semester 1",
    } as never);
  });

  const validInput = { academicYearId: "ay-1", semesterId: "sem-1" };

  it("enforces exam.periods.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(createSpecialExamPeriod(validInput)).rejects.toThrow("FORBIDDEN");
    expect(prisma.semester.findUnique).not.toHaveBeenCalled();
  });

  it("throws SEMESTER_NOT_FOUND when the semester doesn't belong to the given academic year", async () => {
    vi.mocked(prisma.semester.findUnique).mockResolvedValue({
      ...semester,
      academicYearId: "other-year",
    } as never);

    await expect(createSpecialExamPeriod(validInput)).rejects.toThrow("SEMESTER_NOT_FOUND");
    expect(prisma.specialExamPeriod.create).not.toHaveBeenCalled();
  });

  it("blocks a duplicate period for the same academic year + semester with a friendly, specific message", async () => {
    vi.mocked(prisma.specialExamPeriod.findFirst).mockResolvedValue({
      id: "existing",
    } as never);

    await expect(createSpecialExamPeriod(validInput)).rejects.toThrow(
      "A Special Exam Period already exists for 2026-2027 — Semester 1."
    );
    expect(prisma.specialExamPeriod.create).not.toHaveBeenCalled();
  });

  it("auto-composes the name from academic year + semester and audits creation", async () => {
    const period = await createSpecialExamPeriod(validInput);

    expect(prisma.specialExamPeriod.create).toHaveBeenCalledWith({
      data: {
        academicYearId: "ay-1",
        semesterId: "sem-1",
        name: "2026-2027 — Semester 1",
        createdById: "admin-1",
      },
    });
    expect(period).toEqual({ id: "period-1", name: "2026-2027 — Semester 1" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "SPECIAL_EXAM_PERIOD_CREATED",
        entity: "SpecialExamPeriod",
        entityId: "period-1",
      })
    );
  });
});

describe("setSpecialExamPeriodActive", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.specialExamPeriod.findUnique).mockResolvedValue({
      id: "period-1",
      isActive: true,
    } as never);
  });

  it("enforces exam.periods.manage", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(setSpecialExamPeriodActive("period-1", false)).rejects.toThrow("FORBIDDEN");
  });

  it("throws NOT_FOUND for an unknown period", async () => {
    vi.mocked(prisma.specialExamPeriod.findUnique).mockResolvedValue(null);
    await expect(setSpecialExamPeriodActive("missing", false)).rejects.toThrow("NOT_FOUND");
    expect(prisma.specialExamPeriod.update).not.toHaveBeenCalled();
  });

  it("deactivates and audits the old->new value", async () => {
    await setSpecialExamPeriodActive("period-1", false);

    expect(prisma.specialExamPeriod.update).toHaveBeenCalledWith({
      where: { id: "period-1" },
      data: { isActive: false },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SPECIAL_EXAM_PERIOD_DEACTIVATED",
        oldValue: { isActive: true },
        newValue: { isActive: false },
      })
    );
  });

  it("reactivates and audits accordingly", async () => {
    vi.mocked(prisma.specialExamPeriod.findUnique).mockResolvedValue({
      id: "period-1",
      isActive: false,
    } as never);

    await setSpecialExamPeriodActive("period-1", true);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SPECIAL_EXAM_PERIOD_REACTIVATED" })
    );
  });
});
