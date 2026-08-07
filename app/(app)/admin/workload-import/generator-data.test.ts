import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    shift: { findMany: vi.fn() },
    semester: { findFirst: vi.fn() },
    room: { findMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import { getActiveAcademicSemesterNumber, getRoomOptionsForGenerator } from "./generator-data";

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

describe("getRoomOptionsForGenerator", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // Reuses the same unscoped active-room query as the Timetable page's own
  // picker (lib re-exported as getRoomOptions) — this is purely reference
  // data for the multi-class preview's per-session room-override control,
  // not a scheduling input, so it needs no dean-scoping of its own.
  it("delegates to the shared unscoped room list", async () => {
    vi.mocked(prisma.room.findMany).mockResolvedValue([{ id: "room-1", name: "Room 101" }] as never);
    const result = await getRoomOptionsForGenerator();
    expect(result).toEqual([{ id: "room-1", name: "Room 101" }]);
    expect(prisma.room.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } })
    );
  });
});
