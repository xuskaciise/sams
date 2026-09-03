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
      deleteMany: vi.fn(),
    },
    class: { findFirst: vi.fn() },
    student: { findMany: vi.fn() },
    room: { findMany: vi.fn() },
    semester: { findMany: vi.fn(), findUnique: vi.fn() },
    shift: { findMany: vi.fn() },
    whatsAppSettings: { findUnique: vi.fn() },
    classTimetableShare: { findUnique: vi.fn(), upsert: vi.fn() },
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
  sendTimetableNotifications: vi.fn(),
  getRecentTimetableSend: vi.fn(),
  buildClassTimetableGroupShareUrl: vi.fn(),
  TIMETABLE_RESEND_GUARD_MS: 600000,
  WHATSAPP_SETTINGS_ID: "singleton",
}));

import { requirePermission, getUserAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import {
  sendTimetableNotifications,
  getRecentTimetableSend,
  buildClassTimetableGroupShareUrl,
} from "@/lib/whatsapp-notify";
import * as XLSX from "xlsx";
import {
  createTimetableSlot,
  updateTimetableSlot,
  deleteTimetableSlot,
  checkTimetableConflicts,
  getClassScheduleSlots,
  exportTimetable,
  getNowSnapshot,
  clearClassTimetable,
  previewClassTimetableNotifications,
  sendClassTimetableNotifications,
  previewClassTimetableGroupShare,
  shareClassTimetableToGroup,
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
  crossPeriodOverride: false,
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
      lecturer: { fullName: "Dr. Ahmed" },
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
        crossPeriodOverride: false,
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

  it("does NOT send a WhatsApp notification automatically on create (notifications are manual now)", async () => {
    mockRoles(["ADMIN"]);

    await createTimetableSlot(validInput);

    expect(sendTimetableNotifications).not.toHaveBeenCalled();
  });

  it("persists crossPeriodOverride:true — a manual, per-session, opt-in exception the caller explicitly requested", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.timetableSlot.create).mockResolvedValue({
      id: "slot-1",
      ...validInput,
      crossPeriodOverride: true,
    } as never);

    await createTimetableSlot({ ...validInput, crossPeriodOverride: true });

    expect(prisma.timetableSlot.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ crossPeriodOverride: true }) })
    );
  });

  it("returns the created slot — the drag-and-drop grid needs the real id to reconcile its optimistic placeholder", async () => {
    mockRoles(["ADMIN"]);

    const result = await createTimetableSlot(validInput);

    expect(result).toEqual({ id: "slot-1", ...validInput });
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

  it("persists crossPeriodOverride:true — a manual, per-session, opt-in exception the caller explicitly requested", async () => {
    mockRoles(["ADMIN"]);

    await updateTimetableSlot("slot-1", { ...validInput, crossPeriodOverride: true });

    expect(prisma.timetableSlot.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ crossPeriodOverride: true }) })
    );
  });

  it("does NOT send a WhatsApp notification automatically on update", async () => {
    mockRoles(["ADMIN"]);

    await updateTimetableSlot("slot-1", validInput);

    expect(sendTimetableNotifications).not.toHaveBeenCalled();
  });

  it("returns the updated slot — used to reconcile a drag-moved card's optimistic state", async () => {
    mockRoles(["ADMIN"]);

    const result = await updateTimetableSlot("slot-1", validInput);

    expect(result).toEqual({ id: "slot-1", ...validInput });
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

  it("does NOT send a WhatsApp notification automatically on delete", async () => {
    mockRoles(["ADMIN"]);

    await deleteTimetableSlot("slot-1");

    expect(sendTimetableNotifications).not.toHaveBeenCalled();
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

describe("getClassScheduleSlots", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([]);
  });

  it("enforces timetable.view before querying anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(getClassScheduleSlots("class-1", "sem-1")).rejects.toThrow("FORBIDDEN");
    expect(prisma.timetableSlot.findMany).not.toHaveBeenCalled();
  });

  it("a pure ADMIN can target any class, no dean-scope call at all", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.class.findFirst).mockResolvedValue({ id: "class-1" } as never);

    await getClassScheduleSlots("class-1", "sem-1");

    expect(getDeanDepartmentIds).not.toHaveBeenCalled();
    expect(prisma.class.findFirst).toHaveBeenCalledWith({
      where: { id: "class-1" },
      select: { id: true },
    });
    expect(prisma.timetableSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { assignment: { classId: "class-1", semesterId: "sem-1" } },
      })
    );
  });

  it("a DEAN's class lookup is scoped via classDeanWhere", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);
    vi.mocked(prisma.class.findFirst).mockResolvedValue({ id: "class-1" } as never);

    await getClassScheduleSlots("class-1", "sem-1");

    expect(prisma.class.findFirst).toHaveBeenCalledWith({
      where: { id: "class-1", program: { departmentId: { in: ["dept-cs"] } } },
      select: { id: true },
    });
  });

  it("a DEAN targeting an out-of-scope class is rejected without ever querying slots", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);
    vi.mocked(prisma.class.findFirst).mockResolvedValue(null);

    await expect(getClassScheduleSlots("class-1", "sem-1")).rejects.toThrow("CLASS_NOT_FOUND");
    expect(prisma.timetableSlot.findMany).not.toHaveBeenCalled();
  });
});

describe("clearClassTimetable", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.class.findFirst).mockResolvedValue({ id: "class-1", name: "CMS26-A-FT" } as never);
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([
      { id: "slot-1" },
      { id: "slot-2" },
    ] as never);
    vi.mocked(prisma.timetableSlot.deleteMany).mockResolvedValue({ count: 2 } as never);
  });

  it("enforces timetable.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(clearClassTimetable("class-1", "sem-1")).rejects.toThrow("FORBIDDEN");
    expect(prisma.timetableSlot.deleteMany).not.toHaveBeenCalled();
  });

  it("a pure ADMIN can target any class, no dean-scope call at all", async () => {
    mockRoles(["ADMIN"]);

    await clearClassTimetable("class-1", "sem-1");

    expect(getDeanDepartmentIds).not.toHaveBeenCalled();
    expect(prisma.class.findFirst).toHaveBeenCalledWith({
      where: { id: "class-1" },
      select: { id: true, name: true },
    });
  });

  it("a DEAN's class lookup is scoped via classDeanWhere", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);

    await clearClassTimetable("class-1", "sem-1");

    expect(prisma.class.findFirst).toHaveBeenCalledWith({
      where: { id: "class-1", program: { departmentId: { in: ["dept-cs"] } } },
      select: { id: true, name: true },
    });
  });

  it("a DEAN targeting an out-of-scope class is rejected without querying slots", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);
    vi.mocked(prisma.class.findFirst).mockResolvedValue(null);

    await expect(clearClassTimetable("class-1", "sem-1")).rejects.toThrow("CLASS_NOT_FOUND");
    expect(prisma.timetableSlot.findMany).not.toHaveBeenCalled();
    expect(prisma.timetableSlot.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes only this class+semester's slots, audits TIMETABLE_CLEARED with the count, and returns it", async () => {
    mockRoles(["ADMIN"]);

    const result = await clearClassTimetable("class-1", "sem-1");

    expect(prisma.timetableSlot.findMany).toHaveBeenCalledWith({
      where: { assignment: { classId: "class-1", semesterId: "sem-1" } },
      select: { id: true },
    });
    expect(prisma.timetableSlot.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["slot-1", "slot-2"] } },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TIMETABLE_CLEARED",
        entity: "TimetableSlot",
        entityId: "class-1",
        oldValue: expect.objectContaining({ classId: "class-1", className: "CMS26-A-FT", deleted: 2 }),
      })
    );
    expect(result).toEqual({ deleted: 2 });
  });

  it("never touches LecturerCourseAssignment — only TimetableSlot rows are deleted", async () => {
    mockRoles(["ADMIN"]);

    await clearClassTimetable("class-1", "sem-1");

    expect(prisma.lecturerCourseAssignment.findFirst).not.toHaveBeenCalled();
    expect(prisma.lecturerCourseAssignment.findMany).not.toHaveBeenCalled();
  });

  it("is a no-op — no delete call, no audit — when the class already has no slots", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([]);

    const result = await clearClassTimetable("class-1", "sem-1");

    expect(prisma.timetableSlot.deleteMany).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 0 });
  });

  it("does NOT send a WhatsApp notification automatically on clear", async () => {
    mockRoles(["ADMIN"]);

    await clearClassTimetable("class-1", "sem-1");

    expect(sendTimetableNotifications).not.toHaveBeenCalled();
  });

  it("revalidates both the timetable pages and the workload-import pages, so the pending-assignments card refreshes", async () => {
    mockRoles(["ADMIN"]);
    const { revalidatePath } = await import("next/cache");

    await clearClassTimetable("class-1", "sem-1");

    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/admin/workload-import");
    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/dean/workload-import");
  });
});


describe("exportTimetable", () => {
  // 2026-07-27 07:00 UTC = Monday 10:00 in the campus timezone
  // (Africa/Mogadishu, UTC+3) — an ABSOLUTE instant so the resolved
  // "campus now" is Monday 10:00 regardless of the test runner's own zone.
  const MON_10_00 = new Date("2026-07-27T07:00:00.000Z");

  function mockSlot(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "slot-1",
      dayOfWeek: "MON",
      startTime: "09:00",
      endTime: "11:00",
      crossPeriodOverride: false,
      room: { name: "Room 1", campus: { name: "Main Campus" } },
      assignment: {
        id: "asg-1",
        course: { name: "Algorithms" },
        class: {
          name: "CMS26-A-FT",
          currentSemesterNumber: 5,
          studyMode: "FT",
          period: "MORNING",
        },
        lecturer: { fullName: "Dr. Ahmed" },
        semester: { name: "Semester 1" },
      },
      ...overrides,
    };
  }

  const ftMorningShift = (over: Record<string, unknown> = {}) => ({
    studyMode: "FT",
    period: "MORNING",
    ...over,
  });

  function readSheets(base64: string): Record<string, string[][]> {
    const workbook = XLSX.read(Buffer.from(base64, "base64"), { type: "buffer" });
    const out: Record<string, string[][]> = {};
    for (const name of workbook.SheetNames) {
      out[name] = XLSX.utils.sheet_to_json(workbook.Sheets[name], {
        header: 1,
      }) as string[][];
    }
    return out;
  }
  // First sheet's rows.
  const firstSheet = (base64: string) => Object.values(readSheets(base64))[0];
  // Every cell value on a sheet, joined — for "contains" assertions.
  const allText = (rows: string[][]) => rows.flat().join(" || ");

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

  it("'now' renders a grid for today with NOW/NEXT markers, TUE excluded", async () => {
    mockRoles(["ADMIN"]);
    const inProgress = mockSlot({ id: "s-now", startTime: "09:00", endTime: "11:00" });
    const next = mockSlot({ id: "s-next", startTime: "14:00", endTime: "15:00" });
    const tue = mockSlot({ id: "s-tue", dayOfWeek: "TUE", startTime: "08:00", endTime: "09:00" });
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([tue, next, inProgress] as never);

    const { base64, fileName } = await exportTimetable({ quick: "now" });
    const rows = firstSheet(base64);

    expect(fileName).toMatch(/^Timetable_now_\d{4}-\d{2}-\d{2}\.xlsx$/);
    // Header: "Shift" + the one resolved day (Monday).
    expect(rows[0]).toEqual(["Shift", "Monday"]);
    const text = allText(rows);
    expect(text).toContain("Algorithms — Dr. Ahmed (Room 1 — Main Campus) [NOW]");
    expect(text).toContain("14:00–15:00  Algorithms — Dr. Ahmed (Room 1 — Main Campus) [NEXT]");
    expect(text).not.toContain("08:00–09:00"); // the TUE session is gone
  });

  it("'now' combined with an explicit dayOfWeek falls back to the day-filtered grid (Day wins over now)", async () => {
    mockRoles(["ADMIN"]);
    const wed = mockSlot({ id: "s-wed", dayOfWeek: "WED", startTime: "09:00", endTime: "11:00" });
    const mon = mockSlot({ id: "s-mon", dayOfWeek: "MON", startTime: "09:00", endTime: "11:00" });
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([wed, mon] as never);

    const rows = firstSheet((await exportTimetable({ quick: "now", dayOfWeek: "WED" })).base64);

    expect(rows[0]).toEqual(["Shift", "Wednesday"]); // WED only
    const text = allText(rows);
    expect(text).toContain("Algorithms — Dr. Ahmed (Room 1 — Main Campus)");
    expect(text).not.toContain("[NOW]"); // no live split on an explicit day
    expect(text).not.toContain("[NEXT]");
  });

  it("a Shift id + explicit dayOfWeek matches THAT day's window, not today's, and uses real shift rows", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.shift.findMany).mockResolvedValue([
      ftMorningShift({ id: "shift-am", name: "Morning Shift", startTime: "08:00", endTime: "10:00" }),
    ] as never);
    const wedMorning = mockSlot({ id: "s-wed-am", dayOfWeek: "WED", startTime: "09:00", endTime: "10:00" });
    const monMorning = mockSlot({ id: "s-mon-am", dayOfWeek: "MON", startTime: "09:00", endTime: "10:00" });
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([wedMorning, monMorning] as never);

    const rows = firstSheet((await exportTimetable({ quick: "shift-am", dayOfWeek: "WED" })).base64);

    expect(rows[0]).toEqual(["Shift", "Wednesday"]);
    expect(rows[1][0]).toBe("Morning Shift (08:00–10:00)");
    expect(allText(rows)).toContain("09:00–10:00  Algorithms");
    expect(rows).toHaveLength(2); // header + the one shift row; monMorning (MON) absent
  });

  it("a Shift id exports today's sessions inside that ONE shift's window only", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.shift.findMany).mockResolvedValue([
      ftMorningShift({ id: "shift-am", name: "Morning Shift", startTime: "08:00", endTime: "10:00" }),
      ftMorningShift({ id: "shift-pm", name: "Afternoon Shift", startTime: "13:00", endTime: "15:00" }),
    ] as never);
    const inMorning = mockSlot({ id: "s-am", startTime: "09:00", endTime: "10:00" });
    const inAfternoon = mockSlot({ id: "s-pm", startTime: "13:30", endTime: "14:30" });
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([inMorning, inAfternoon] as never);

    const { base64, fileName } = await exportTimetable({ quick: "shift-am" });
    const text = allText(firstSheet(base64));

    expect(fileName).toMatch(/^Timetable_Morning_Shift_\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(text).toContain("09:00–10:00  Algorithms"); // inMorning
    expect(text).not.toContain("13:30–14:30"); // inAfternoon filtered out
  });

  it("picking the OTHER shift exports only that shift's own window", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.shift.findMany).mockResolvedValue([
      ftMorningShift({ id: "shift-am", name: "Morning Shift", startTime: "08:00", endTime: "10:00" }),
      ftMorningShift({ id: "shift-pm", name: "Afternoon Shift", startTime: "13:00", endTime: "15:00" }),
    ] as never);
    const inMorning = mockSlot({ id: "s-am", startTime: "09:00", endTime: "10:00" });
    const inAfternoon = mockSlot({ id: "s-pm", startTime: "13:30", endTime: "14:30" });
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([inMorning, inAfternoon] as never);

    const text = allText(firstSheet((await exportTimetable({ quick: "shift-pm" })).base64));

    expect(text).toContain("13:30–14:30  Algorithms");
    expect(text).not.toContain("09:00–10:00");
  });

  it("an unrecognized quick value falls back to the full week (all valid days)", async () => {
    mockRoles(["ADMIN"]);
    const mon = mockSlot({ id: "s-mon", dayOfWeek: "MON" });
    const tue = mockSlot({ id: "s-tue", dayOfWeek: "TUE" });
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([mon, tue] as never);

    const rows = firstSheet((await exportTimetable({ quick: "shift-deleted-long-ago" })).base64);

    // FT valid days -> Sat, Sun, Mon, Tue, Wed columns.
    expect(rows[0]).toEqual(["Shift", "Saturday", "Sunday", "Monday", "Tuesday", "Wednesday"]);
    expect(allText(rows)).toContain("Algorithms"); // both sessions land in their day columns
  });

  it("'full' with no dayOfWeek exports every returned slot across the week", async () => {
    mockRoles(["ADMIN"]);
    const mon = mockSlot({ id: "s-mon", dayOfWeek: "MON" });
    const tue = mockSlot({ id: "s-tue", dayOfWeek: "TUE" });
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([mon, tue] as never);

    const rows = firstSheet((await exportTimetable({ quick: "full" })).base64);

    expect(rows[0][0]).toBe("Shift");
    expect(rows[0]).toHaveLength(6); // Shift + 5 FT days
    expect(rows).toHaveLength(2); // one synthesized time row (both sessions 09:00-11:00)
    const monCol = rows[0].indexOf("Monday");
    const tueCol = rows[0].indexOf("Tuesday");
    expect(rows[1][monCol]).toContain("Algorithms");
    expect(rows[1][tueCol]).toContain("Algorithms");
  });

  it("'full' with an explicit dayOfWeek narrows to just that day", async () => {
    mockRoles(["ADMIN"]);
    const mon = mockSlot({ id: "s-mon", dayOfWeek: "MON" });
    const tue = mockSlot({ id: "s-tue", dayOfWeek: "TUE" });
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([mon, tue] as never);

    const rows = firstSheet((await exportTimetable({ quick: "full", dayOfWeek: "TUE" })).base64);

    expect(rows[0]).toEqual(["Shift", "Tuesday"]);
    expect(allText(rows)).toContain("Algorithms");
  });

  it("splits classes with different (studyMode, period) into separate sheets", async () => {
    mockRoles(["ADMIN"]);
    const ftMorning = mockSlot({ id: "s-ft" });
    const pt = mockSlot({
      id: "s-pt",
      dayOfWeek: "THU",
      assignment: {
        id: "asg-2",
        course: { name: "Networking" },
        class: { name: "CMS26-B-PT", currentSemesterNumber: 3, studyMode: "PT", period: null },
        lecturer: { fullName: "Dr. Omar" },
        semester: { name: "Semester 1" },
      },
    });
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([ftMorning, pt] as never);

    const sheets = readSheets((await exportTimetable({ quick: "full" })).base64);

    expect(Object.keys(sheets)).toEqual(["Full-time — Morning", "Part-time"]);
    expect(allText(sheets["Full-time — Morning"])).toContain("Algorithms");
    expect(allText(sheets["Full-time — Morning"])).not.toContain("Networking");
    expect(allText(sheets["Part-time"])).toContain("Networking");
  });

  it("no matching sessions produces a header-only sheet, never a throw", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([] as never);

    const rows = firstSheet((await exportTimetable({ quick: "now" })).base64);
    expect(rows).toEqual([["Shift"]]);
  });

  it("an unassigned DEAN gets a header-only export, not an error", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue([]);

    const rows = firstSheet((await exportTimetable({ quick: "full" })).base64);
    expect(rows).toEqual([["Shift"]]);
    expect(prisma.timetableSlot.findMany).not.toHaveBeenCalled();
  });
});

describe("previewClassTimetableNotifications / sendClassTimetableNotifications", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.class.findFirst).mockResolvedValue({ id: "class-1", name: "CMS26-A-FT" } as never);
    vi.mocked(prisma.semester.findUnique).mockResolvedValue({
      name: "Semester 1",
      academicYear: { name: "2026-2027" },
    } as never);
    vi.mocked(prisma.student.findMany).mockResolvedValue([
      { id: "s1", fullName: "Amina", phoneNumber: "+252611111111", classId: "class-1", class: { name: "CMS26-A-FT" } },
      { id: "s2", fullName: "Bashir", phoneNumber: null, classId: "class-1", class: { name: "CMS26-A-FT" } },
    ] as never);
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([
      {
        assignment: {
          lecturerId: "l1",
          classId: "class-1",
          lecturer: { fullName: "Dr. Ahmed", phoneNumber: "+252633333333" },
          class: { name: "CMS26-A-FT" },
        },
      },
    ] as never);
    vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({ id: "singleton", enabled: true } as never);
    vi.mocked(getRecentTimetableSend).mockResolvedValue({ lastQueuedAt: null, stillPending: 0 });
    vi.mocked(sendTimetableNotifications).mockResolvedValue({
      enqueuedStudents: 1,
      enqueuedLecturers: 1,
      skipped: 1,
    });
  });

  it("requires timetable.manage", async () => {
    await previewClassTimetableNotifications("class-1", "sem-1");
    expect(requirePermission).toHaveBeenCalledWith("timetable.manage");
  });

  it("rejects a class out of the caller's scope", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-x"]);
    vi.mocked(prisma.class.findFirst).mockResolvedValue(null);

    await expect(sendClassTimetableNotifications("class-1", "sem-1")).rejects.toThrow("CLASS_NOT_FOUND");
    expect(sendTimetableNotifications).not.toHaveBeenCalled();
  });

  it("preview reports student/lecturer/with-phone counts and the enabled flag", async () => {
    const preview = await previewClassTimetableNotifications("class-1", "sem-1");
    expect(preview).toMatchObject({
      className: "CMS26-A-FT",
      studentCount: 2,
      lecturerCount: 1,
      withPhoneCount: 2, // s1 + l1 have phones; s2 does not
      whatsappEnabled: true,
      lastQueuedAt: null,
    });
  });

  it("send fans out to sendTimetableNotifications and audits TIMETABLE_NOTIFICATIONS_SENT", async () => {
    const result = await sendClassTimetableNotifications("class-1", "sem-1");

    expect(sendTimetableNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        recipients: expect.arrayContaining([
          expect.objectContaining({ type: "STUDENT", id: "s1" }),
          expect.objectContaining({ type: "LECTURER", id: "l1" }),
        ]),
        changeSummary: expect.stringContaining("CMS26-A-FT"),
      })
    );
    expect(result).toMatchObject({ enqueuedStudents: 1, enqueuedLecturers: 1, whatsappEnabled: true });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TIMETABLE_NOTIFICATIONS_SENT",
        entity: "Class",
        entityId: "class-1",
        newValue: expect.objectContaining({ scope: "class", resent: false }),
      })
    );
  });

  it("refuses a repeat send within the guard window unless force is passed", async () => {
    vi.mocked(getRecentTimetableSend).mockResolvedValue({
      lastQueuedAt: new Date().toISOString(),
      stillPending: 3,
    });

    await expect(sendClassTimetableNotifications("class-1", "sem-1")).rejects.toThrow("RECENTLY_SENT");
    expect(sendTimetableNotifications).not.toHaveBeenCalled();

    await sendClassTimetableNotifications("class-1", "sem-1", true);
    expect(sendTimetableNotifications).toHaveBeenCalledTimes(1);
  });
});

describe("getNowSnapshot", () => {
  // 2026-07-27 07:00 UTC = Monday 10:00 campus time (Africa/Mogadishu).
  const MON_10_00 = new Date("2026-07-27T07:00:00.000Z");

  function slot(over: Record<string, unknown>) {
    return {
      id: "s",
      dayOfWeek: "MON",
      startTime: "09:00",
      endTime: "11:00",
      crossPeriodOverride: false,
      room: { name: "R1", campus: { name: "Main" } },
      assignment: {
        id: "a",
        course: { name: "Algorithms" },
        class: { name: "CMS26-A-FT", currentSemesterNumber: 5, studyMode: "FT", period: "MORNING" },
        lecturer: { fullName: "Dr. Ahmed", availability: [] },
        semester: { name: "Semester 1" },
        creditHours: null,
      },
      ...over,
    };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.semester.findMany).mockResolvedValue([{ id: "sem-1", isActive: true }] as never);
    vi.useFakeTimers();
    vi.setSystemTime(MON_10_00);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enforces timetable.view", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(getNowSnapshot({})).rejects.toThrow("FORBIDDEN");
  });

  it("splits TODAY's sessions into in-progress / next, excludes ended and other days, never a future day", async () => {
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([
      slot({ id: "now", startTime: "09:00", endTime: "11:00" }), // in progress (10:00 campus)
      slot({ id: "next", startTime: "13:00", endTime: "14:00" }), // later today
      slot({ id: "ended", startTime: "07:00", endTime: "08:00" }), // over
      slot({ id: "tue", dayOfWeek: "TUE", startTime: "09:00", endTime: "10:00" }), // other day
    ] as never);

    const snap = await getNowSnapshot({});

    expect(snap.day).toBe("MON");
    expect(snap.time).toBe("10:00");
    expect(snap.inProgress.map((s) => s.id)).toEqual(["now"]);
    expect(snap.next.map((s) => s.id)).toEqual(["next"]);
  });

  it("today with nothing left -> empty snapshot, still MON (no jump to another day)", async () => {
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([
      slot({ id: "over", startTime: "07:00", endTime: "08:00" }),
      slot({ id: "fri", dayOfWeek: "FRI", startTime: "09:00", endTime: "10:00" }),
    ] as never);

    const snap = await getNowSnapshot({});

    expect(snap).toMatchObject({ day: "MON", inProgress: [], next: [] });
  });
});

describe("Share timetable to WhatsApp Group — previewClassTimetableGroupShare / shareClassTimetableToGroup", () => {
  const classRow = { id: "class-1", name: "CMS26-A-FT", currentSemesterNumber: 3 };
  const semesterRow = { name: "Semester 1", academicYear: { name: "2026-2027" } };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.class.findFirst).mockResolvedValue(classRow as never);
    vi.mocked(prisma.semester.findUnique).mockResolvedValue(semesterRow as never);
    vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({
      id: "singleton",
      domainName: "sams.university.edu",
    } as never);
    vi.mocked(prisma.classTimetableShare.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.classTimetableShare.upsert).mockResolvedValue({} as never);
    vi.mocked(buildClassTimetableGroupShareUrl).mockResolvedValue({
      url: "https://wa.me/?text=hello",
    });
  });

  it("enforces timetable.manage", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(previewClassTimetableGroupShare("class-1", "sem-1")).rejects.toThrow("FORBIDDEN");
    await expect(shareClassTimetableToGroup("class-1", "sem-1")).rejects.toThrow("FORBIDDEN");
  });

  it("rejects a class outside the caller's scope", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-x"]);
    vi.mocked(prisma.class.findFirst).mockResolvedValue(null);
    await expect(shareClassTimetableToGroup("class-1", "sem-1")).rejects.toThrow("CLASS_NOT_FOUND");
    expect(buildClassTimetableGroupShareUrl).not.toHaveBeenCalled();
  });

  it("preview reports the label, semester and domain-configured flag; lastSharedAt null on a first share", async () => {
    const preview = await previewClassTimetableGroupShare("class-1", "sem-1");
    expect(preview).toEqual({
      className: "CMS26-A-FT (Semester 3)",
      semesterLabel: "Semester 1 (2026-2027)",
      domainConfigured: true,
      lastSharedAt: null,
    });
  });

  it("preview surfaces a prior share's timestamp", async () => {
    const when = new Date("2026-09-01T09:00:00.000Z");
    vi.mocked(prisma.classTimetableShare.findUnique).mockResolvedValue({ sharedAt: when } as never);
    const preview = await previewClassTimetableGroupShare("class-1", "sem-1");
    expect(preview.lastSharedAt).toBe(when.toISOString());
  });

  it("share: throws DOMAIN_NOT_CONFIGURED when no login domain is set — records nothing", async () => {
    vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({
      id: "singleton",
      domainName: null,
    } as never);
    await expect(shareClassTimetableToGroup("class-1", "sem-1")).rejects.toThrow("DOMAIN_NOT_CONFIGURED");
    expect(prisma.classTimetableShare.upsert).not.toHaveBeenCalled();
    expect(buildClassTimetableGroupShareUrl).not.toHaveBeenCalled();
  });

  it("share: builds the phone-number-less wa.me link from the class's real data, records + audits, never touches the worker", async () => {
    const res = await shareClassTimetableToGroup("class-1", "sem-1");

    expect(res.url).toBe("https://wa.me/?text=hello");
    expect(buildClassTimetableGroupShareUrl).toHaveBeenCalledWith({
      className: "CMS26-A-FT (Semester 3)",
      semesterName: "Semester 1",
      academicYear: "2026-2027",
      domainName: "sams.university.edu",
    });
    expect(prisma.classTimetableShare.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { classId_semesterId: { classId: "class-1", semesterId: "sem-1" } },
        create: { classId: "class-1", semesterId: "sem-1", sharedById: "user-1" },
      })
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CLASS_TIMETABLE_GROUP_SHARED",
        entity: "Class",
        entityId: "class-1",
        newValue: expect.objectContaining({ semesterId: "sem-1", reshared: false }),
      })
    );
    // no per-recipient send, no worker queue
    expect(sendTimetableNotifications).not.toHaveBeenCalled();
  });

  it("share: a repeat within the guard window is soft-blocked unless force; force marks reshared:true", async () => {
    vi.mocked(prisma.classTimetableShare.findUnique).mockResolvedValue({
      sharedAt: new Date(),
    } as never);

    await expect(shareClassTimetableToGroup("class-1", "sem-1")).rejects.toThrow("ALREADY_SHARED");
    expect(buildClassTimetableGroupShareUrl).not.toHaveBeenCalled();

    await shareClassTimetableToGroup("class-1", "sem-1", true);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CLASS_TIMETABLE_GROUP_SHARED",
        newValue: expect.objectContaining({ reshared: true }),
      })
    );
  });

  it("share: an OLD prior share (outside the guard window) is allowed without force", async () => {
    vi.mocked(prisma.classTimetableShare.findUnique).mockResolvedValue({
      sharedAt: new Date(Date.now() - 3_600_000), // 1h ago, guard is 600000ms
    } as never);

    const res = await shareClassTimetableToGroup("class-1", "sem-1");
    expect(res.url).toBe("https://wa.me/?text=hello");
  });
});
