import { describe, it, expect, vi, beforeEach } from "vitest";

const mockUser = { id: "user-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
  getUserAccess: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    class: { findMany: vi.fn(), update: vi.fn() },
    room: { findMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    timetableSlot: { findMany: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  },
}));

vi.mock("@/lib/dean-scope", () => ({
  getDeanDepartmentIds: vi.fn(),
  classDeanWhere: vi.fn((ids: string[]) => ({
    program: { departmentId: { in: ids } },
  })),
}));

// The conflict-candidate fetch is mocked; findTimetableConflicts (pure)
// stays REAL so the actual overlap / room-match logic is exercised.
vi.mock("../timetable/queries", () => ({
  getConflictCandidates: vi.fn(async () => []),
}));

import { requirePermission, getUserAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import { getConflictCandidates } from "../timetable/queries";
import { previewRoomReassignment, applyRoomReassignment } from "./actions";

// ── fixtures ─────────────────────────────────────────────────────────
// 4 FT classes, each in a room, department "dept-1" (except class-x in
// "dept-2" for the dean-scope test).
const ALL_CLASSES = [
  { id: "class-a", name: "CMS23-A-FT", roomId: "room-13", roomName: "Room 13", departmentId: "dept-1" },
  { id: "class-b", name: "CMS24-B-FT", roomId: "room-12", roomName: "Room 12", departmentId: "dept-1" },
  { id: "class-c", name: "CMS23-C-FT", roomId: "room-16", roomName: "Room 16", departmentId: "dept-1" },
  { id: "class-d", name: "CMS24-D-FT", roomId: "room-7", roomName: "Room 7", departmentId: "dept-1" },
  { id: "class-x", name: "OTHER-FT", roomId: "room-99", roomName: "Room 99", departmentId: "dept-2" },
];

const ALL_ROOMS = [
  { id: "room-4", name: "Room 4" },
  { id: "room-7", name: "Room 7" },
  { id: "room-12", name: "Room 12" },
  { id: "room-13", name: "Room 13" },
  { id: "room-16", name: "Room 16" },
  { id: "room-99", name: "Room 99" },
];

// Each class's own TimetableSlots (what prisma.timetableSlot.findMany
// returns for `where.assignment.classId`).
let slotsByClass: Record<string, unknown[]> = {};
// The full per-semester conflict-candidate list.
let candidates: unknown[] = [];

function cand(over: Record<string, unknown>) {
  return {
    id: "x",
    dayOfWeek: "MON",
    startTime: "09:00",
    endTime: "10:00",
    roomId: "room-0",
    roomName: "Room 0",
    lecturerId: "lec-0",
    lecturerName: "L",
    classId: "class-0",
    className: "C0",
    courseName: "Course0",
    ...over,
  };
}

function ownSlot(over: Record<string, unknown>) {
  return {
    id: "s",
    dayOfWeek: "MON",
    startTime: "09:00",
    endTime: "10:00",
    assignment: { semesterId: "s1", lecturerId: "lec-0" },
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
  vi.mocked(getUserAccess).mockResolvedValue({ roleNames: ["ADMIN"], permissions: new Set() } as never);
  vi.mocked(getDeanDepartmentIds).mockResolvedValue([]);

  slotsByClass = {};
  candidates = [];

  vi.mocked(prisma.class.findMany).mockImplementation((async (args: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = (args as any).where;
    const ids: string[] = w.id.in;
    let pool = ALL_CLASSES;
    if (w.program) {
      const deptIn: string[] = w.program.departmentId.in;
      pool = pool.filter((c) => deptIn.includes(c.departmentId));
    }
    return pool
      .filter((c) => ids.includes(c.id))
      .map((c) => ({ id: c.id, name: c.name, roomId: c.roomId, room: { name: c.roomName } }));
  }) as never);

  vi.mocked(prisma.room.findMany).mockImplementation((async (args: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ids: string[] = (args as any).where.id.in;
    return ALL_ROOMS.filter((r) => ids.includes(r.id));
  }) as never);

  vi.mocked(prisma.timetableSlot.findMany).mockImplementation((async (args: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cid = (args as any).where.assignment.classId;
    const ids: string[] = typeof cid === "string" ? [cid] : cid.in;
    // buildReassignmentPlan selects assignment.classId; inject it so its
    // in-memory grouping works (fixtures don't include it per-slot).
    return ids.flatMap((id) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (slotsByClass[id] ?? []).map((s: any) => ({
        ...s,
        assignment: { ...s.assignment, classId: id },
      }))
    );
  }) as never);

  vi.mocked(getConflictCandidates).mockImplementation((async () => candidates) as never);
});

describe("previewRoomReassignment / applyRoomReassignment — permission", () => {
  it("both require timetable.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(
      previewRoomReassignment({ rows: [{ classId: "class-a", newRoomId: "room-16" }] })
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      applyRoomReassignment({ rows: [{ classId: "class-a", newRoomId: "room-16" }] })
    ).rejects.toThrow("FORBIDDEN");
    expect(prisma.class.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("dean scoping", () => {
  it("rejects a class outside the dean's faculty", async () => {
    vi.mocked(getUserAccess).mockResolvedValue({ roleNames: ["DEAN"], permissions: new Set() } as never);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-1"]);

    await expect(
      previewRoomReassignment({
        rows: [
          { classId: "class-a", newRoomId: "room-16" },
          { classId: "class-x", newRoomId: "room-4" }, // dept-2 — out of scope
        ],
      })
    ).rejects.toThrow(/not available for reassignment/);
  });
});

describe("chain / cycle succeeds atomically", () => {
  it("B->13, A->16, D->4 with the taken rooms' occupants also in the batch: no conflicts, one transaction, one audit", async () => {
    // A(13)->16, B(12)->13, C(16)->12, D(7)->4  — a clean 3-cycle + D.
    slotsByClass = {
      "class-a": [ownSlot({ id: "sa1", dayOfWeek: "MON", startTime: "09:00", endTime: "10:00", assignment: { semesterId: "s1", lecturerId: "lec-a" } })],
      "class-b": [ownSlot({ id: "sb1", dayOfWeek: "TUE", startTime: "10:00", endTime: "11:00", assignment: { semesterId: "s1", lecturerId: "lec-b" } })],
      "class-c": [ownSlot({ id: "sc1", dayOfWeek: "MON", startTime: "09:00", endTime: "10:00", assignment: { semesterId: "s1", lecturerId: "lec-c" } })],
      "class-d": [ownSlot({ id: "sd1", dayOfWeek: "WED", startTime: "08:00", endTime: "09:00", assignment: { semesterId: "s1", lecturerId: "lec-d" } })],
    };
    candidates = [
      cand({ id: "sa1", dayOfWeek: "MON", startTime: "09:00", endTime: "10:00", roomId: "room-13", classId: "class-a", className: "CMS23-A-FT" }),
      cand({ id: "sb1", dayOfWeek: "TUE", startTime: "10:00", endTime: "11:00", roomId: "room-12", classId: "class-b", className: "CMS24-B-FT" }),
      cand({ id: "sc1", dayOfWeek: "MON", startTime: "09:00", endTime: "10:00", roomId: "room-16", classId: "class-c", className: "CMS23-C-FT" }),
      cand({ id: "sd1", dayOfWeek: "WED", startTime: "08:00", endTime: "09:00", roomId: "room-7", classId: "class-d", className: "CMS24-D-FT" }),
    ];

    const rows = [
      { classId: "class-b", newRoomId: "room-13" },
      { classId: "class-a", newRoomId: "room-16" },
      { classId: "class-c", newRoomId: "room-12" },
      { classId: "class-d", newRoomId: "room-4" },
    ];

    const { plan } = await previewRoomReassignment({ rows });
    expect(plan.conflicts).toEqual([]);
    expect(plan.changes).toHaveLength(4);
    expect(plan.changes.find((c) => c.classId === "class-a")).toMatchObject({
      oldRoomName: "Room 13",
      newRoomName: "Room 16",
      movedSessions: 1,
    });

    const result = await applyRoomReassignment({ rows });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // 4 class.update + 4 timetableSlot.updateMany
    expect(prisma.class.update).toHaveBeenCalledTimes(4);
    expect(prisma.timetableSlot.updateMany).toHaveBeenCalledTimes(4);
    expect(prisma.class.update).toHaveBeenCalledWith({ where: { id: "class-a" }, data: { roomId: "room-16" } });
    expect(prisma.timetableSlot.updateMany).toHaveBeenCalledWith({
      where: { assignment: { classId: "class-b" } },
      data: { roomId: "room-13" },
    });
    expect(result).toMatchObject({ applied: 4, totalMovedSessions: 4 });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        action: "CLASS_ROOMS_REASSIGNED",
        entity: "Class",
      })
    );
    // one entry for the whole batch, not one per class
    expect(audit).toHaveBeenCalledTimes(1);
  });
});

describe("transient mid-chain overlap is NOT a conflict", () => {
  it("A(13)->16 and B(12)->13: B taking 13 while A still holds it is fine (final state only)", async () => {
    slotsByClass = {
      "class-a": [ownSlot({ id: "sa1", dayOfWeek: "MON", startTime: "09:00", endTime: "10:00", assignment: { semesterId: "s1", lecturerId: "lec-a" } })],
      "class-b": [ownSlot({ id: "sb1", dayOfWeek: "MON", startTime: "09:00", endTime: "10:00", assignment: { semesterId: "s1", lecturerId: "lec-b" } })],
    };
    candidates = [
      cand({ id: "sa1", dayOfWeek: "MON", startTime: "09:00", endTime: "10:00", roomId: "room-13", classId: "class-a" }),
      cand({ id: "sb1", dayOfWeek: "MON", startTime: "09:00", endTime: "10:00", roomId: "room-12", classId: "class-b" }),
    ];

    const { plan } = await previewRoomReassignment({
      rows: [
        { classId: "class-a", newRoomId: "room-16" },
        { classId: "class-b", newRoomId: "room-13" },
      ],
    });
    expect(plan.conflicts).toEqual([]);
  });
});

describe("genuine third-party conflict blocks the whole batch", () => {
  it("A->16 where Room 16 is held by class-c (NOT in the batch) at an overlapping time", async () => {
    slotsByClass = {
      "class-a": [ownSlot({ id: "sa1", dayOfWeek: "MON", startTime: "09:00", endTime: "10:00", assignment: { semesterId: "s1", lecturerId: "lec-a" } })],
    };
    candidates = [
      cand({ id: "sa1", dayOfWeek: "MON", startTime: "09:00", endTime: "10:00", roomId: "room-13", classId: "class-a" }),
      cand({ id: "sc1", dayOfWeek: "MON", startTime: "09:30", endTime: "10:30", roomId: "room-16", roomName: "Room 16", classId: "class-c", className: "CMS23-C-FT", courseName: "Networks" }),
    ];

    const rows = [{ classId: "class-a", newRoomId: "room-16" }];

    const { plan } = await previewRoomReassignment({ rows });
    expect(plan.conflicts.length).toBeGreaterThan(0);
    expect(plan.conflicts[0]).toMatch(/Room 16 is already booked for Networks \(CMS23-C-FT\)/);

    await expect(applyRoomReassignment({ rows })).rejects.toThrow(
      /can't be applied — it collides with bookings outside the batch/
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.class.update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("two participants ending in the SAME room at overlapping times is a conflict", () => {
  it("A->16 and B->16, both with a MON 09:00-10:00 session", async () => {
    slotsByClass = {
      "class-a": [ownSlot({ id: "sa1", dayOfWeek: "MON", startTime: "09:00", endTime: "10:00", assignment: { semesterId: "s1", lecturerId: "lec-a" } })],
      "class-b": [ownSlot({ id: "sb1", dayOfWeek: "MON", startTime: "09:00", endTime: "10:00", assignment: { semesterId: "s1", lecturerId: "lec-b" } })],
    };
    candidates = [
      cand({ id: "sa1", dayOfWeek: "MON", startTime: "09:00", endTime: "10:00", roomId: "room-13", classId: "class-a", className: "CMS23-A-FT" }),
      cand({ id: "sb1", dayOfWeek: "MON", startTime: "09:00", endTime: "10:00", roomId: "room-12", classId: "class-b", className: "CMS24-B-FT" }),
    ];

    const { plan } = await previewRoomReassignment({
      rows: [
        { classId: "class-a", newRoomId: "room-16" },
        { classId: "class-b", newRoomId: "room-16" },
      ],
    });
    expect(plan.conflicts.length).toBeGreaterThan(0);
  });
});

describe("no-op rows are ignored", () => {
  it("a row whose newRoomId equals its current room does not count as a change", async () => {
    slotsByClass = { "class-a": [] };
    candidates = [];
    await expect(
      previewRoomReassignment({
        rows: [{ classId: "class-a", newRoomId: "room-13" }], // already in room-13
      })
    ).rejects.toThrow(/No room changes were submitted/);
  });
});
