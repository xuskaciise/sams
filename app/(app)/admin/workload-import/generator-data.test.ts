import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    shift: { findMany: vi.fn() },
    semester: { findFirst: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import { getActiveAcademicSemesterNumber } from "./generator-data";

describe("getActiveAcademicSemesterNumber", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns the active semester's own semesterNumber", async () => {
    vi.mocked(prisma.semester.findFirst).mockResolvedValue({ semesterNumber: 2 } as never);
    expect(await getActiveAcademicSemesterNumber()).toBe(2);
    expect(prisma.semester.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } })
    );
  });

  it("returns null when there's no active semester at all", async () => {
    vi.mocked(prisma.semester.findFirst).mockResolvedValue(null);
    expect(await getActiveAcademicSemesterNumber()).toBeNull();
  });

  it("returns null when the active semester's own semesterNumber hasn't been set", async () => {
    vi.mocked(prisma.semester.findFirst).mockResolvedValue({ semesterNumber: null } as never);
    expect(await getActiveAcademicSemesterNumber()).toBeNull();
  });
});
