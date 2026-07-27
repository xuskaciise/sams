import { describe, it, expect, vi, beforeEach } from "vitest";

const mockUser = { id: "user-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
  getUserAccess: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    lecturerCourseAssignment: { findFirst: vi.fn(), findMany: vi.fn() },
    timetableSlot: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    class: { findFirst: vi.fn() },
    room: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/dean-scope", () => ({
  getDeanDepartmentIds: vi.fn(),
  assignmentDeanWhere: vi.fn((ids: string[]) => ({
    class: { program: { departmentId: { in: ids } } },
  })),
  classDeanWhere: vi.fn((ids: string[]) => ({
    program: { departmentId: { in: ids } },
  })),
}));

import { requirePermission, getUserAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import {
  createTimetableSlot,
  updateTimetableSlot,
  deleteTimetableSlot,
  checkTimetableConflicts,
  buildClassTimetable,
} from "./actions";

function mockRoles(roleNames: string[]) {
  vi.mocked(getUserAccess).mockResolvedValue({
    permissions: new Set(),
    roleNames,
  } as never);
}

const assignment = {
  id: "assign-1",
  lecturerId: "lect-2",
  courseId: "course-1",
  classId: "class-2",
  semesterId: "sem-1",
  class: { studyMode: "FT" },
};

const validInput = {
  lecturerCourseAssignmentId: "assign-1",
  dayOfWeek: "MON" as const,
  startTime: "09:30",
  endTime: "10:30",
  roomId: "room-2",
};

// A slot that overlaps validInput's day/time but differs in room/lecturer/
// class — the baseline "no conflict" candidate.
function nonConflictingCandidate() {
  return {
    id: "slot-existing",
    dayOfWeek: "MON",
    startTime: "09:00",
    endTime: "10:00",
    roomId: "room-1",
    room: { name: "A101" },
    assignment: {
      lecturerId: "lect-1",
      classId: "class-1",
      lecturer: { user: { fullName: "Dr. Ahmed" } },
      course: { name: "DB Systems" },
      class: { name: "CMS-A" },
    },
  };
}

describe("createTimetableSlot", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue(
      assignment as never
    );
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([]);
    vi.mocked(prisma.timetableSlot.create).mockResolvedValue({
      id: "slot-1",
      ...validInput,
    } as never);
  });

  it("enforces timetable.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(createTimetableSlot(validInput)).rejects.toThrow("FORBIDDEN");
    expect(prisma.timetableSlot.create).not.toHaveBeenCalled();
  });

  it("a pure ADMIN can target any assignment, no dean-scope check at all", async () => {
    mockRoles(["ADMIN"]);

    await createTimetableSlot(validInput);

    expect(getDeanDepartmentIds).not.toHaveBeenCalled();
    expect(prisma.lecturerCourseAssignment.findFirst).toHaveBeenCalledWith({
      where: { id: "assign-1" },
      include: { class: { select: { studyMode: true } } },
    });
    expect(prisma.timetableSlot.create).toHaveBeenCalledWith({
      data: {
        lecturerCourseAssignmentId: "assign-1",
        dayOfWeek: "MON",
        startTime: "09:30",
        endTime: "10:30",
        roomId: "room-2",
      },
    });
  });

  it("a DEAN's assignment lookup is scoped via assignmentDeanWhere", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);

    await createTimetableSlot(validInput);

    expect(prisma.lecturerCourseAssignment.findFirst).toHaveBeenCalledWith({
      where: {
        id: "assign-1",
        class: { program: { departmentId: { in: ["dept-cs"] } } },
      },
      include: { class: { select: { studyMode: true } } },
    });
  });

  it("a DEAN targeting an out-of-scope assignment is rejected", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue(null);

    await expect(createTimetableSlot(validInput)).rejects.toThrow(
      "ASSIGNMENT_NOT_FOUND"
    );
    expect(prisma.timetableSlot.create).not.toHaveBeenCalled();
  });

  it("creates the slot when candidates overlap in time but not room/lecturer/class", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([
      nonConflictingCandidate(),
    ] as never);

    await createTimetableSlot(validInput);

    expect(prisma.timetableSlot.create).toHaveBeenCalled();
  });

  it("blocks on a room conflict with a clear message naming the room and existing booking", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([
      nonConflictingCandidate(),
    ] as never);

    await expect(
      createTimetableSlot({ ...validInput, roomId: "room-1" })
    ).rejects.toThrow(/Room A101 is already booked for DB Systems/);
    expect(prisma.timetableSlot.create).not.toHaveBeenCalled();
  });

  it("blocks on a lecturer conflict (same lecturer, overlapping day+time, different class)", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([
      nonConflictingCandidate(),
    ] as never);
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue({
      ...assignment,
      lecturerId: "lect-1",
    } as never);

    await expect(createTimetableSlot(validInput)).rejects.toThrow(
      /Dr\. Ahmed already teaches/
    );
    expect(prisma.timetableSlot.create).not.toHaveBeenCalled();
  });

  it("blocks on a class conflict (same class, overlapping day+time)", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([
      nonConflictingCandidate(),
    ] as never);
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue({
      ...assignment,
      classId: "class-1",
    } as never);

    await expect(createTimetableSlot(validInput)).rejects.toThrow(
      /CMS-A already has DB Systems scheduled/
    );
    expect(prisma.timetableSlot.create).not.toHaveBeenCalled();
  });

  it("does not conflict across different semesters — candidates are fetched scoped to the assignment's own semester", async () => {
    mockRoles(["ADMIN"]);

    await createTimetableSlot(validInput);

    expect(prisma.timetableSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { assignment: { semesterId: "sem-1" } },
      })
    );
  });

  it("audits TIMETABLE_SLOT_CREATED", async () => {
    mockRoles(["ADMIN"]);

    await createTimetableSlot(validInput);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        action: "TIMETABLE_SLOT_CREATED",
        entity: "TimetableSlot",
        entityId: "slot-1",
      })
    );
  });

  it("rejects a day outside the class's studyMode (THU is PT-only, this class is FT)", async () => {
    mockRoles(["ADMIN"]);

    await expect(
      createTimetableSlot({ ...validInput, dayOfWeek: "THU" })
    ).rejects.toThrow(/not a valid teaching day/);
    expect(prisma.timetableSlot.create).not.toHaveBeenCalled();
  });

  it("allows a PT-only day for a PT class", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue({
      ...assignment,
      class: { studyMode: "PT" },
    } as never);

    await createTimetableSlot({ ...validInput, dayOfWeek: "THU" });

    expect(prisma.timetableSlot.create).toHaveBeenCalled();
  });

  it("allows any day when the class has no studyMode set (legacy/incomplete data)", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue({
      ...assignment,
      class: { studyMode: null },
    } as never);

    await createTimetableSlot({ ...validInput, dayOfWeek: "THU" });

    expect(prisma.timetableSlot.create).toHaveBeenCalled();
  });
});

describe("updateTimetableSlot", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue(
      assignment as never
    );
    vi.mocked(prisma.timetableSlot.findFirst).mockResolvedValue({
      id: "slot-1",
      lecturerCourseAssignmentId: "assign-old",
      dayOfWeek: "TUE",
      startTime: "08:00",
      endTime: "09:00",
      roomId: "room-9",
    } as never);
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([]);
    vi.mocked(prisma.timetableSlot.update).mockResolvedValue({
      id: "slot-1",
      ...validInput,
    } as never);
  });

  it("rejects editing a slot that is out of the caller's scope", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);
    vi.mocked(prisma.timetableSlot.findFirst).mockResolvedValue(null);

    await expect(updateTimetableSlot("slot-1", validInput)).rejects.toThrow(
      "SLOT_NOT_FOUND"
    );
    expect(prisma.timetableSlot.update).not.toHaveBeenCalled();
  });

  it("excludes itself from conflict candidates via excludeSlotId, so an unchanged slot never conflicts with itself", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([
      { ...nonConflictingCandidate(), id: "slot-1", roomId: "room-2" },
    ] as never);

    await updateTimetableSlot("slot-1", validInput);

    expect(prisma.timetableSlot.update).toHaveBeenCalled();
  });

  it("still blocks on a genuine conflict with a DIFFERENT existing slot", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([
      { ...nonConflictingCandidate(), id: "slot-other", roomId: "room-2" },
    ] as never);

    await expect(updateTimetableSlot("slot-1", validInput)).rejects.toThrow(
      /already booked/
    );
    expect(prisma.timetableSlot.update).not.toHaveBeenCalled();
  });

  it("audits TIMETABLE_SLOT_UPDATED with old and new values", async () => {
    mockRoles(["ADMIN"]);

    await updateTimetableSlot("slot-1", validInput);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        action: "TIMETABLE_SLOT_UPDATED",
        entity: "TimetableSlot",
        entityId: "slot-1",
        oldValue: expect.objectContaining({ dayOfWeek: "TUE" }),
        newValue: expect.objectContaining({ dayOfWeek: "MON" }),
      })
    );
  });
});

describe("deleteTimetableSlot", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.timetableSlot.findFirst).mockResolvedValue({
      id: "slot-1",
      lecturerCourseAssignmentId: "assign-1",
      dayOfWeek: "MON",
      startTime: "09:00",
      endTime: "10:00",
      roomId: "room-1",
    } as never);
    vi.mocked(prisma.timetableSlot.delete).mockResolvedValue({} as never);
  });

  it("rejects deleting a slot out of the caller's scope", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);
    vi.mocked(prisma.timetableSlot.findFirst).mockResolvedValue(null);

    await expect(deleteTimetableSlot("slot-1")).rejects.toThrow("SLOT_NOT_FOUND");
    expect(prisma.timetableSlot.delete).not.toHaveBeenCalled();
  });

  it("deletes and audits TIMETABLE_SLOT_DELETED with the old value", async () => {
    mockRoles(["ADMIN"]);

    await deleteTimetableSlot("slot-1");

    expect(prisma.timetableSlot.delete).toHaveBeenCalledWith({ where: { id: "slot-1" } });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TIMETABLE_SLOT_DELETED",
        entityId: "slot-1",
        oldValue: expect.objectContaining({ roomId: "room-1" }),
      })
    );
  });
});

describe("checkTimetableConflicts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue(
      assignment as never
    );
  });

  it("returns conflicts without ever creating a slot — pure preview", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([
      nonConflictingCandidate(),
    ] as never);

    const conflicts = await checkTimetableConflicts({
      ...validInput,
      roomId: "room-1",
    });

    expect(conflicts.length).toBeGreaterThan(0);
    expect(prisma.timetableSlot.create).not.toHaveBeenCalled();
  });

  it("returns an empty array when nothing conflicts", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([]);

    const conflicts = await checkTimetableConflicts(validInput);

    expect(conflicts).toEqual([]);
  });
});

describe("buildClassTimetable", () => {
  const classRow = { id: "class-1", studyMode: "FT" };
  const assignA = {
    id: "assign-a",
    lecturerId: "lect-a",
    classId: "class-1",
    semesterId: "sem-1",
    lecturer: { user: { fullName: "Dr. A" } },
    course: { name: "Course A" },
    class: { name: "CMS-A" },
  };
  const assignB = {
    id: "assign-b",
    lecturerId: "lect-b",
    classId: "class-1",
    semesterId: "sem-1",
    lecturer: { user: { fullName: "Dr. B" } },
    course: { name: "Course B" },
    class: { name: "CMS-A" },
  };
  const roomX = { id: "room-x", name: "Room X" };
  const roomY = { id: "room-y", name: "Room Y" };

  const baseWeekInput = {
    classId: "class-1",
    semesterId: "sem-1",
    sessions: [
      {
        key: "s1",
        lecturerCourseAssignmentId: "assign-a",
        dayOfWeek: "SAT" as const,
        startTime: "09:00",
        endTime: "10:00",
        roomId: "room-x",
      },
      {
        key: "s2",
        lecturerCourseAssignmentId: "assign-b",
        dayOfWeek: "SUN" as const,
        startTime: "10:00",
        endTime: "11:00",
        roomId: "room-y",
      },
    ],
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.class.findFirst).mockResolvedValue(classRow as never);
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      assignA,
      assignB,
    ] as never);
    vi.mocked(prisma.room.findMany).mockResolvedValue([roomX, roomY] as never);
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([]);
    vi.mocked(prisma.timetableSlot.createMany).mockResolvedValue({ count: 2 } as never);
  });

  it("enforces timetable.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(buildClassTimetable(baseWeekInput)).rejects.toThrow("FORBIDDEN");
    expect(prisma.timetableSlot.createMany).not.toHaveBeenCalled();
  });

  it("a DEAN's class lookup is scoped via classDeanWhere; out of scope throws CLASS_NOT_FOUND", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);
    vi.mocked(prisma.class.findFirst).mockResolvedValue(null);

    await expect(buildClassTimetable(baseWeekInput)).rejects.toThrow("CLASS_NOT_FOUND");
    expect(prisma.timetableSlot.createMany).not.toHaveBeenCalled();
  });

  it("creates every session in one createMany call when the whole week is clean", async () => {
    mockRoles(["ADMIN"]);

    const result = await buildClassTimetable(baseWeekInput);

    expect(result).toEqual({ ok: true, created: 2 });
    expect(prisma.timetableSlot.createMany).toHaveBeenCalledWith({
      data: [
        {
          lecturerCourseAssignmentId: "assign-a",
          dayOfWeek: "SAT",
          startTime: "09:00",
          endTime: "10:00",
          roomId: "room-x",
        },
        {
          lecturerCourseAssignmentId: "assign-b",
          dayOfWeek: "SUN",
          startTime: "10:00",
          endTime: "11:00",
          roomId: "room-y",
        },
      ],
    });
  });

  it("returns ok:false with a per-session violation for a day outside the class's studyMode — creates nothing", async () => {
    mockRoles(["ADMIN"]);

    const result = await buildClassTimetable({
      ...baseWeekInput,
      sessions: [{ ...baseWeekInput.sessions[0], dayOfWeek: "THU" }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].sessionKey).toBe("s1");
      expect(result.violations[0].message).toMatch(/not a valid teaching day/);
    }
    expect(prisma.timetableSlot.createMany).not.toHaveBeenCalled();
  });

  it("returns ok:false when a session's assignment does not belong to the given class+semester", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([assignA] as never);

    const result = await buildClassTimetable(baseWeekInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.sessionKey === "s2")).toBe(true);
    }
    expect(prisma.timetableSlot.createMany).not.toHaveBeenCalled();
  });

  it("flags two sessions in the SAME submitted batch that conflict with each other — nothing in the DB yet", async () => {
    mockRoles(["ADMIN"]);

    const result = await buildClassTimetable({
      classId: "class-1",
      semesterId: "sem-1",
      sessions: [
        {
          key: "s1",
          lecturerCourseAssignmentId: "assign-a",
          dayOfWeek: "SAT",
          startTime: "09:00",
          endTime: "10:00",
          roomId: "room-x",
        },
        {
          key: "s2",
          lecturerCourseAssignmentId: "assign-b",
          dayOfWeek: "SAT",
          startTime: "09:30",
          endTime: "10:30",
          roomId: "room-x",
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Both assignments share the same class, so this pair conflicts on
      // BOTH room and class — each session gets an entry per conflict
      // kind found, not just one.
      const keys = new Set(result.violations.map((v) => v.sessionKey));
      expect(keys).toEqual(new Set(["s1", "s2"]));
    }
    expect(prisma.timetableSlot.createMany).not.toHaveBeenCalled();
  });

  it("flags a submitted session that conflicts with an EXISTING DB slot", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([
      {
        id: "existing-1",
        dayOfWeek: "SAT",
        startTime: "09:00",
        endTime: "10:00",
        roomId: "room-x",
        room: { name: "Room X" },
        assignment: {
          lecturerId: "lect-other",
          classId: "class-other",
          lecturer: { user: { fullName: "Dr. Other" } },
          course: { name: "Other Course" },
          class: { name: "Other Class" },
        },
      },
    ] as never);

    const result = await buildClassTimetable(baseWeekInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.sessionKey === "s1")).toBe(true);
    }
    expect(prisma.timetableSlot.createMany).not.toHaveBeenCalled();
  });

  it("audits TIMETABLE_WEEK_BUILT with classId/semesterId/sessionCount on success", async () => {
    mockRoles(["ADMIN"]);

    await buildClassTimetable(baseWeekInput);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        action: "TIMETABLE_WEEK_BUILT",
        entity: "TimetableSlot",
        newValue: { classId: "class-1", semesterId: "sem-1", sessionCount: 2 },
      })
    );
  });
});
