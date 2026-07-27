import { describe, it, expect, vi, beforeEach } from "vitest";

const mockUser = { id: "user-1" };
const campusA = "campus-a";
const campusB = "campus-b";

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
    room: { findMany: vi.fn(), createMany: vi.fn() },
  },
}));

import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { previewBulkRooms, bulkCreateRooms } from "./actions";

describe("previewBulkRooms", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.room.findMany).mockResolvedValue([]);
  });

  it("enforces timetable.manage before querying anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(previewBulkRooms(campusA, [{ name: "Room 101" }])).rejects.toThrow("FORBIDDEN");
    expect(prisma.room.findMany).not.toHaveBeenCalled();
  });

  it("classifies a fresh, unique name as OK", async () => {
    const result = await previewBulkRooms(campusA, [{ name: "Room 101" }]);
    expect(result).toEqual([{ name: "Room 101", status: "OK" }]);
  });

  it("flags EVERY occurrence of a name repeated within the batch, not just the 2nd+", async () => {
    const result = await previewBulkRooms(campusA, [
      { name: "Room 101" },
      { name: "Room 101" },
      { name: "Room 102" },
    ]);

    expect(result[0].status).toBe("DUPLICATE_IN_BATCH");
    expect(result[1].status).toBe("DUPLICATE_IN_BATCH");
    expect(result[2].status).toBe("OK");
  });

  it("flags a name that already exists at the SAME campus — checked without a deletedAt filter", async () => {
    vi.mocked(prisma.room.findMany).mockResolvedValue([{ name: "Room 101" }] as never);

    const result = await previewBulkRooms(campusA, [{ name: "Room 101" }, { name: "Room 102" }]);

    expect(prisma.room.findMany).toHaveBeenCalledWith({
      where: { campusId: campusA, name: { in: ["Room 101", "Room 102"] } },
      select: { name: true },
    });
    expect(result[0].status).toBe("ALREADY_EXISTS");
    expect(result[1].status).toBe("OK");
  });

  it("the same name is OK at a DIFFERENT campus — uniqueness is per-campus, not global", async () => {
    // "Room 101" exists, but only the query scoped to campusA would ever
    // return it — a campusB preview never even asks about campusA's rows.
    vi.mocked(prisma.room.findMany).mockResolvedValue([]);

    const result = await previewBulkRooms(campusB, [{ name: "Room 101" }]);

    expect(prisma.room.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ campusId: campusB }) })
    );
    expect(result).toEqual([{ name: "Room 101", status: "OK" }]);
  });

  it("rejects an empty batch", async () => {
    await expect(previewBulkRooms(campusA, [])).rejects.toThrow();
  });

  it("rejects a batch larger than the max size", async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({ name: `Room ${i}` }));
    await expect(previewBulkRooms(campusA, rows)).rejects.toThrow();
  });
});

describe("bulkCreateRooms", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.room.findMany).mockResolvedValue([]);
    vi.mocked(prisma.room.createMany).mockResolvedValue({ count: 0 } as never);
  });

  it("enforces timetable.manage before writing anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(bulkCreateRooms(campusA, [{ name: "Room 101" }])).rejects.toThrow("FORBIDDEN");
    expect(prisma.room.createMany).not.toHaveBeenCalled();
  });

  it("creates all rows under the given campus in one createMany call when nothing conflicts", async () => {
    const result = await bulkCreateRooms(campusA, [
      { name: "Room 101", capacity: 40 },
      { name: "Room 102" },
    ]);

    expect(prisma.room.createMany).toHaveBeenCalledWith({
      data: [
        { campusId: campusA, name: "Room 101", capacity: 40 },
        { campusId: campusA, name: "Room 102", capacity: null },
      ],
      skipDuplicates: true,
    });
    expect(result).toEqual({ created: 2, skipped: 0 });
  });

  it("skips names that already exist at that campus, still creating the rest, never failing the whole batch", async () => {
    vi.mocked(prisma.room.findMany).mockResolvedValue([{ name: "Room 101" }] as never);

    const result = await bulkCreateRooms(campusA, [{ name: "Room 101" }, { name: "Room 102" }]);

    expect(prisma.room.createMany).toHaveBeenCalledWith({
      data: [{ campusId: campusA, name: "Room 102", capacity: null }],
      skipDuplicates: true,
    });
    expect(result).toEqual({ created: 1, skipped: 1 });
  });

  it("re-checks existence server-side rather than trusting the client's preview classification", async () => {
    // Simulates a race: this name didn't exist at preview time but does
    // now, right before the transaction.
    vi.mocked(prisma.room.findMany).mockResolvedValue([{ name: "Room 101" }] as never);

    const result = await bulkCreateRooms(campusA, [{ name: "Room 101" }]);

    expect(prisma.room.createMany).not.toHaveBeenCalled();
    expect(result).toEqual({ created: 0, skipped: 1 });
  });

  it("de-dupes within the submitted batch itself, keeping only the first occurrence", async () => {
    const result = await bulkCreateRooms(campusA, [{ name: "Room 101" }, { name: "Room 101" }]);

    expect(prisma.room.createMany).toHaveBeenCalledWith({
      data: [{ campusId: campusA, name: "Room 101", capacity: null }],
      skipDuplicates: true,
    });
    expect(result).toEqual({ created: 1, skipped: 1 });
  });

  it("does not call createMany at all when every row is skipped", async () => {
    vi.mocked(prisma.room.findMany).mockResolvedValue([{ name: "Room 101" }] as never);

    await bulkCreateRooms(campusA, [{ name: "Room 101" }]);

    expect(prisma.room.createMany).not.toHaveBeenCalled();
  });

  it("audits TIMETABLE_ROOMS_BULK_CREATED with campusId + requested/created/skipped counts", async () => {
    vi.mocked(prisma.room.findMany).mockResolvedValue([{ name: "Room 101" }] as never);

    await bulkCreateRooms(campusA, [{ name: "Room 101" }, { name: "Room 102" }]);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        action: "TIMETABLE_ROOMS_BULK_CREATED",
        entity: "Room",
        newValue: { campusId: campusA, requested: 2, created: 1, skipped: 1 },
      })
    );
  });
});
