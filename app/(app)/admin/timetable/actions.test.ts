import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
    semester: { findMany: vi.fn() },
    shift: { findMany: vi.fn() },
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

vi.mock("@/lib/whatsapp-notify", () => ({
  notifyTimetableChange: vi.fn(),
}));

import { requirePermission, getUserAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import { notifyTimetableChange } from "@/lib/whatsapp-notify";
import * as XLSX from "xlsx";
import {
  createTimetableSlot,
  updateTimetableSlot,
  deleteTimetableSlot,
  checkTimetableConflicts,
  buildClassTimetable,
  exportTimetable,
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

  it("notifies the class's students via WhatsApp (best-effort) after creating", async () => {
    mockRoles(["ADMIN"]);

    await createTimetableSlot(validInput);

    expect(notifyTimetableChange).toHaveBeenCalledWith(
      assignment.classId,
      expect.any(String)
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

  it("notifies the class's students via WhatsApp (best-effort) after updating", async () => {
    mockRoles(["ADMIN"]);

    await updateTimetableSlot("slot-1", validInput);

    expect(notifyTimetableChange).toHaveBeenCalledWith(
      assignment.classId,
      expect.any(String)
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
      assignment: { classId: "class-1" },
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

  it("notifies the class's students via WhatsApp (best-effort) after deleting", async () => {
    mockRoles(["ADMIN"]);

    await deleteTimetableSlot("slot-1");

    expect(notifyTimetableChange).toHaveBeenCalledWith("class-1", expect.any(String));
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

  it("notifies the class's students via WhatsApp (best-effort) once for the whole batch", async () => {
    mockRoles(["ADMIN"]);

    await buildClassTimetable(baseWeekInput);

    expect(notifyTimetableChange).toHaveBeenCalledTimes(1);
    expect(notifyTimetableChange).toHaveBeenCalledWith("class-1", expect.any(String));
  });
});

describe("exportTimetable", () => {
  // Monday 2026-07-27, 10:00 — a fixed "now" so Now/Morning/Afternoon
  // resolve deterministically.
  const MON_10_00 = new Date(2026, 6, 27, 10, 0);

  function mockSlot(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "slot-1",
      dayOfWeek: "MON",
      startTime: "09:00",
      endTime: "11:00",
      room: { name: "Room 1", campus: { name: "Main Campus" } },
      assignment: {
        course: { name: "Algorithms" },
        class: { name: "CMS26-A-FT" },
        lecturer: { user: { fullName: "Dr. Ahmed" } },
        semester: { name: "Semester 1" },
      },
      ...overrides,
    };
  }

  function readRows(base64: string): unknown[][] {
    const workbook = XLSX.read(Buffer.from(base64, "base64"), { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.semester.findMany).mockResolvedValue([
      { id: "sem-1", isActive: true },
    ] as never);
    vi.mocked(prisma.shift.findMany).mockResolvedValue([]);
    vi.useFakeTimers();
    vi.setSystemTime(MON_10_00);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enforces timetable.view before querying anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(exportTimetable({ quick: "now" })).rejects.toThrow("FORBIDDEN");
    expect(prisma.timetableSlot.findMany).not.toHaveBeenCalled();
  });

  it("'now' exports the in-progress and next sessions for today, in that order", async () => {
    mockRoles(["ADMIN"]);
    const inProgress = mockSlot({ id: "s-now", startTime: "09:00", endTime: "11:00" });
    const next = mockSlot({ id: "s-next", startTime: "14:00", endTime: "15:00" });
    const yesterday = mockSlot({ id: "s-tue", dayOfWeek: "TUE", startTime: "08:00", endTime: "09:00" });
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([yesterday, next, inProgress] as never);

    const { base64, fileName } = await exportTimetable({ quick: "now" });
    const rows = readRows(base64);

    expect(fileName).toMatch(/^Timetable_now_\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(rows[0]).toEqual([
      "Day", "Start", "End", "Status", "Course", "Class", "Lecturer", "Room", "Campus", "Semester",
    ]);
    expect(rows[1][3]).toBe("In Progress");
    expect(rows[1][1]).toBe("09:00");
    expect(rows[2][3]).toBe("Next");
    expect(rows[2][1]).toBe("14:00");
    expect(rows).toHaveLength(3); // header + 2 rows, TUE session excluded
  });

  it("'now' combined with an explicit dayOfWeek falls back to full-week/day-filtered — Day always wins over now's live semantics", async () => {
    mockRoles(["ADMIN"]);
    const wed = mockSlot({ id: "s-wed", dayOfWeek: "WED", startTime: "09:00", endTime: "11:00" });
    const mon = mockSlot({ id: "s-mon", dayOfWeek: "MON", startTime: "09:00", endTime: "11:00" });
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([wed, mon] as never);

    const { base64 } = await exportTimetable({ quick: "now", dayOfWeek: "WED" });
    const rows = readRows(base64);

    expect(rows).toHaveLength(2); // header + WED only, not the "now" in-progress/next split
    expect(rows[1][3]).toBe("Scheduled");
    expect(rows[1][0]).toBe("Wednesday");
  });

  it("a Shift id combined with an explicit dayOfWeek matches that DAY's window, not today's", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.shift.findMany).mockResolvedValue([
      { id: "shift-am", name: "Morning Shift", startTime: "08:00", endTime: "10:00" },
    ] as never);
    // "now" is Monday 10:00 (MON_10_00) — a matching session on Wednesday
    // must still be picked up when dayOfWeek=WED is explicitly selected.
    const wedMorning = mockSlot({ id: "s-wed-am", dayOfWeek: "WED", startTime: "09:00", endTime: "10:00" });
    const monMorning = mockSlot({ id: "s-mon-am", dayOfWeek: "MON", startTime: "09:00", endTime: "10:00" });
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([wedMorning, monMorning] as never);

    const { base64 } = await exportTimetable({ quick: "shift-am", dayOfWeek: "WED" });
    const rows = readRows(base64);

    expect(rows).toHaveLength(2); // header + the WED session only
    expect(rows[1][0]).toBe("Wednesday");
  });

  it("a Shift id exports today's sessions falling inside that ONE shift's window only", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.shift.findMany).mockResolvedValue([
      { id: "shift-am", name: "Morning Shift", startTime: "08:00", endTime: "10:00" },
      { id: "shift-pm", name: "Afternoon Shift", startTime: "13:00", endTime: "15:00" },
    ] as never);
    const inMorning = mockSlot({ id: "s-am", startTime: "09:00", endTime: "10:00" });
    const inAfternoon = mockSlot({ id: "s-pm", startTime: "13:30", endTime: "14:30" });
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([inMorning, inAfternoon] as never);

    const { base64, fileName } = await exportTimetable({ quick: "shift-am" });
    const rows = readRows(base64);

    expect(rows).toHaveLength(2); // header + inMorning only
    expect(rows[1][1]).toBe("09:00");
    expect(fileName).toMatch(/^Timetable_Morning_Shift_\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it("picking the OTHER shift exports only that shift's own window", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.shift.findMany).mockResolvedValue([
      { id: "shift-am", name: "Morning Shift", startTime: "08:00", endTime: "10:00" },
      { id: "shift-pm", name: "Afternoon Shift", startTime: "13:00", endTime: "15:00" },
    ] as never);
    const inMorning = mockSlot({ id: "s-am", startTime: "09:00", endTime: "10:00" });
    const inAfternoon = mockSlot({ id: "s-pm", startTime: "13:30", endTime: "14:30" });
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([inMorning, inAfternoon] as never);

    const { base64 } = await exportTimetable({ quick: "shift-pm" });
    const rows = readRows(base64);

    expect(rows).toHaveLength(2);
    expect(rows[1][1]).toBe("13:30");
  });

  it("an unrecognized quick value (e.g. a deactivated shift's stale id) falls back to full week", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.shift.findMany).mockResolvedValue([
      { id: "shift-am", name: "Morning Shift", startTime: "08:00", endTime: "10:00" },
    ] as never);
    const mon = mockSlot({ id: "s-mon", dayOfWeek: "MON" });
    const tue = mockSlot({ id: "s-tue", dayOfWeek: "TUE" });
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([mon, tue] as never);

    const { base64 } = await exportTimetable({ quick: "shift-deleted-long-ago" });
    const rows = readRows(base64);

    expect(rows).toHaveLength(3); // both sessions, unfiltered by day
  });

  it("'full' with no dayOfWeek exports every returned slot regardless of day", async () => {
    mockRoles(["ADMIN"]);
    const mon = mockSlot({ id: "s-mon", dayOfWeek: "MON" });
    const tue = mockSlot({ id: "s-tue", dayOfWeek: "TUE" });
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([mon, tue] as never);

    const { base64 } = await exportTimetable({ quick: "full" });
    const rows = readRows(base64);

    expect(rows).toHaveLength(3);
  });

  it("'full' with an explicit dayOfWeek narrows to just that day", async () => {
    mockRoles(["ADMIN"]);
    const mon = mockSlot({ id: "s-mon", dayOfWeek: "MON" });
    const tue = mockSlot({ id: "s-tue", dayOfWeek: "TUE" });
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([mon, tue] as never);

    const { base64 } = await exportTimetable({ quick: "full", dayOfWeek: "TUE" });
    const rows = readRows(base64);

    expect(rows).toHaveLength(2);
    expect(rows[1][0]).toBe("Tuesday");
  });

  it("no matching sessions produces a header-only sheet, never a throw", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([] as never);

    const { base64 } = await exportTimetable({ quick: "now" });
    const rows = readRows(base64);

    expect(rows).toHaveLength(1);
  });

  it("an unassigned DEAN gets a header-only export, not an error", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue([]);

    const { base64 } = await exportTimetable({ quick: "full" });
    const rows = readRows(base64);

    expect(rows).toHaveLength(1);
    expect(prisma.timetableSlot.findMany).not.toHaveBeenCalled();
  });
});
