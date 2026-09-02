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

vi.mock("@/lib/dean-scope", () => ({
  getDeanDepartmentIds: vi.fn(),
  assignmentDeanWhere: vi.fn((ids: string[]) => ({ class: { program: { departmentId: { in: ids } } } })),
  classDeanWhere: vi.fn((ids: string[]) => ({ program: { departmentId: { in: ids } } })),
  lecturerDeanWhere: vi.fn((ids: string[]) => ({ assignments: { some: { class: { program: { departmentId: { in: ids } } } } } })),
}));

vi.mock("@/lib/whatsapp-notify", () => ({
  sendTimetableNotifications: vi.fn(),
  getRecentTimetableSend: vi.fn(),
  sendTimetableReady: vi.fn(),
  TIMETABLE_RESEND_GUARD_MS: 600000,
  WHATSAPP_SETTINGS_ID: "singleton",
}));

vi.mock("../timetable/queries", () => ({
  getConflictCandidates: vi.fn(),
  getShiftOptions: vi.fn(),
  resolveTimetableNotificationRecipients: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    lecturerCourseAssignment: { findMany: vi.fn() },
    timetableSlot: { createMany: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
    semester: { findFirst: vi.fn() },
    class: { findMany: vi.fn() },
    lecturer: { findMany: vi.fn(), update: vi.fn() },
    shift: { findMany: vi.fn() },
    lecturerAvailability: { deleteMany: vi.fn(), createMany: vi.fn() },
    whatsAppSettings: { findUnique: vi.fn() },
    lecturerTimetableNotification: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
    $transaction: vi.fn(),
  },
  BULK_TRANSACTION_OPTIONS: { timeout: 30000, maxWait: 10000 },
}));

import { requirePermission, getUserAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import { sendTimetableNotifications, getRecentTimetableSend, sendTimetableReady } from "@/lib/whatsapp-notify";
import {
  getConflictCandidates,
  getShiftOptions,
  resolveTimetableNotificationRecipients,
} from "../timetable/queries";
import {
  previewAutoTimetableBatch,
  confirmAutoTimetableBatch,
  previewClearSemesterTimetable,
  clearSemesterLevelTimetable,
  saveLecturerAvailableDaysForGeneration,
  previewSendTimetableBatchNotifications,
  sendTimetableBatchNotifications,
  previewSendTimetableReady,
  sendTimetableReadyToLecturer,
  sendTimetableReadyBatch,
} from "./actions";

function mockRoles(roleNames: string[]) {
  vi.mocked(getUserAccess).mockResolvedValue({ permissions: new Set(), roleNames } as never);
}

const shift1h = {
  id: "shift-1h",
  name: "Shift 1",
  studyMode: "FT",
  period: "MORNING",
  startTime: "08:00",
  endTime: "09:00",
};

// Room is a class-registration property now (Class.roomId) — the
// assignment's class relation carries it directly, never a per-call
// client-supplied room.
const assignmentRow = {
  id: "assign-1",
  lecturerId: "lect-1",
  courseId: "course-1",
  classId: "class-1",
  semesterId: "sem-1",
  creditHours: 1,
  class: {
    id: "class-1",
    name: "CMS26-A-FT",
    studyMode: "FT",
    period: "MORNING",
    currentSemesterNumber: 3,
    roomId: "room-1",
    room: { name: "Room 101", campus: { name: "Main Campus" } },
  },
  course: { name: "Databases" },
  lecturer: { fullName: "Dr. Ahmed", availability: [] as { dayOfWeek: string; shift: unknown }[] },
};

describe("previewAutoTimetableBatch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([assignmentRow] as never);
    vi.mocked(getShiftOptions).mockResolvedValue([shift1h] as never);
    vi.mocked(getConflictCandidates).mockResolvedValue([]);
  });

  const input = {
    semesterId: "sem-1",
    semesterNumber: 3,
    assignments: [{ assignmentId: "assign-1" }],
  };

  it("enforces the timetable.generate permission before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(previewAutoTimetableBatch(input)).rejects.toThrow("FORBIDDEN");
    expect(prisma.lecturerCourseAssignment.findMany).not.toHaveBeenCalled();
  });

  it("schedules a valid assignment successfully with no writes, using the class's own room", async () => {
    const result = await previewAutoTimetableBatch(input);
    expect(result.scheduledNormally).toHaveLength(1);
    expect(result.scheduledNormally[0].roomId).toBe("room-1");
    expect(result.skippedAssignmentIds).toHaveLength(0);
    expect(result.classesWithoutRoom).toHaveLength(0);
    expect(result.classesWithoutPeriod).toHaveLength(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("scopes the assignment lookup to the dean's own faculty (assignmentDeanWhere applied)", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);
    await previewAutoTimetableBatch(input);
    expect(prisma.lecturerCourseAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          class: expect.objectContaining({ program: { departmentId: { in: ["dept-cs"] } } }),
        }),
      })
    );
  });

  it("reports an out-of-scope/wrong-level assignment id as skipped, not silently ignored", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([]); // nothing matches
    const result = await previewAutoTimetableBatch(input);
    expect(result.skippedAssignmentIds).toEqual(["assign-1"]);
    expect(result.scheduledNormally).toHaveLength(0);
  });

  it("never trusts the client's creditHours — uses the DB row's value", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      { ...assignmentRow, creditHours: 2.5 },
    ] as never);
    vi.mocked(getShiftOptions).mockResolvedValue([
      {
        id: "shift-2.5h",
        name: "Shift 3",
        studyMode: "FT",
        period: "MORNING",
        startTime: "11:00",
        endTime: "13:30",
      },
    ] as never);
    const result = await previewAutoTimetableBatch(input);
    expect(result.scheduledNormally[0]).toMatchObject({ startTime: "11:00", endTime: "13:30" });
  });

  it("carries the lecturer's availability through to the algorithm — a restricted lecturer is only ever scheduled within it", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      { ...assignmentRow, lecturer: { fullName: "Dr. Ahmed", availability: [{ dayOfWeek: "SAT", shift: null }] } },
    ] as never);
    const result = await previewAutoTimetableBatch(input);
    expect(result.unscheduled).toHaveLength(0);
    expect(result.scheduledNormally[0].dayOfWeek).toBe("SAT");
  });

  it("carries a day+shift-level restriction through to the algorithm — only the listed shift on the listed day is used", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      {
        ...assignmentRow,
        lecturer: {
          fullName: "Dr. Ahmed",
          availability: [{ dayOfWeek: "SAT", shift: { id: "shift-1h", name: "Shift 1", studyMode: "FT", period: "MORNING" } }],
        },
      },
    ] as never);
    const result = await previewAutoTimetableBatch(input);
    expect(result.unscheduled).toHaveLength(0);
    expect(result.scheduledNormally[0]).toMatchObject({ dayOfWeek: "SAT", shiftId: "shift-1h" });
  });

  it("reports Unscheduled with the lecturer-restriction reason when availability has zero day overlap with the class's valid days", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      {
        ...assignmentRow,
        lecturer: {
          fullName: "Dr. Ahmed",
          availability: [
            { dayOfWeek: "THU", shift: null },
            { dayOfWeek: "FRI", shift: null },
          ],
        },
      }, // class is FT
    ] as never);
    const result = await previewAutoTimetableBatch(input);
    expect(result.scheduledNormally).toHaveLength(0);
    expect(result.unscheduled).toHaveLength(1);
    expect(result.unscheduled[0].reason).toContain("Lecturer only available Thu and Fri");
  });

  it("reports a class with no roomId as classesWithoutRoom and excludes it from scheduling, never guessing a room", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      { ...assignmentRow, class: { ...assignmentRow.class, roomId: null, room: null } },
    ] as never);
    const result = await previewAutoTimetableBatch(input);
    expect(result.scheduledNormally).toHaveLength(0);
    expect(result.classesWithoutRoom).toEqual([{ classId: "class-1", className: "CMS26-A-FT" }]);
  });

  it("reports an FT class with no period as classesWithoutPeriod and excludes it from scheduling, never guessing a period", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      { ...assignmentRow, class: { ...assignmentRow.class, period: null } },
    ] as never);
    const result = await previewAutoTimetableBatch(input);
    expect(result.scheduledNormally).toHaveLength(0);
    expect(result.classesWithoutPeriod).toEqual([{ classId: "class-1", className: "CMS26-A-FT" }]);
  });

  it("never flags a PT class as classesWithoutPeriod — period is FT-only", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      {
        ...assignmentRow,
        class: { ...assignmentRow.class, studyMode: "PT", period: null },
      },
    ] as never);
    vi.mocked(getShiftOptions).mockResolvedValue([
      { id: "pt-shift", name: "PT Shift", studyMode: "PT", period: null, startTime: "14:00", endTime: "15:00" },
    ] as never);
    const result = await previewAutoTimetableBatch(input);
    expect(result.classesWithoutPeriod).toHaveLength(0);
    expect(result.scheduledNormally).toHaveLength(1);
  });

  it("restricts an FT assignment's shift search to shifts matching its class's own period", async () => {
    vi.mocked(getShiftOptions).mockResolvedValue([
      shift1h,
      { id: "galab-1", name: "Galab 1aad", studyMode: "FT", period: "AFTERNOON", startTime: "13:00", endTime: "14:30" },
    ] as never);
    const result = await previewAutoTimetableBatch(input);
    expect(result.scheduledNormally).toHaveLength(1);
    expect(result.scheduledNormally[0].shiftId).toBe("shift-1h"); // the Morning shift, never Galab
  });
});

describe("confirmAutoTimetableBatch", () => {
  const session = {
    assignmentId: "assign-1",
    classId: "class-1",
    roomId: "room-1",
    dayOfWeek: "SAT" as const,
    startTime: "08:00",
    endTime: "09:00",
    crossPeriodOverride: false,
  };
  const confirmInput = { semesterId: "sem-1", semesterNumber: 3, sessions: [session] };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([assignmentRow] as never);
    vi.mocked(getConflictCandidates).mockResolvedValue([]);
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) =>
      (fn as (tx: unknown) => unknown)({ timetableSlot: { createMany: vi.fn() } })
    );
  });

  it("enforces the timetable.generate permission before writing anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(confirmAutoTimetableBatch(confirmInput)).rejects.toThrow("FORBIDDEN");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("creates the session via one transactional createMany call", async () => {
    const result = await confirmAutoTimetableBatch(confirmInput);
    expect(result.created).toBe(1);
    expect(result.skippedDueToRaceConflict).toBe(0);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000, maxWait: 10000 });
  });

  it("persists each session's crossPeriodOverride flag — a manual, per-session, opt-in exception the caller explicitly requested (never set by this action itself)", async () => {
    const createMany = vi.fn();
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) =>
      (fn as (tx: unknown) => unknown)({ timetableSlot: { createMany } })
    );

    await confirmAutoTimetableBatch({
      ...confirmInput,
      sessions: [{ ...session, crossPeriodOverride: true }],
    });

    expect(createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ crossPeriodOverride: true })],
    });
  });

  it("re-validates against FRESH conflict candidates and skips a session that now conflicts (race safety)", async () => {
    vi.mocked(getConflictCandidates).mockResolvedValue([
      {
        id: "existing-1",
        dayOfWeek: "SAT",
        startTime: "08:00",
        endTime: "09:00",
        roomId: "room-1",
        roomName: "Room 101",
        lecturerId: "lect-1",
        lecturerName: "Dr. Ahmed",
        classId: "some-other-class",
        className: "Other Class",
        courseName: "Other Course",
      },
    ] as never);
    const result = await confirmAutoTimetableBatch(confirmInput);
    expect(result.created).toBe(0);
    expect(result.skippedDueToRaceConflict).toBe(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("never force-writes a session whose assignment fell out of scope since preview", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([]); // now out of scope
    const result = await confirmAutoTimetableBatch(confirmInput);
    expect(result.created).toBe(0);
    expect(result.skippedDueToRaceConflict).toBe(1);
  });

  it("audits AUTO_TIMETABLE_GENERATED with semester/level/counts", async () => {
    await confirmAutoTimetableBatch(confirmInput);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        action: "AUTO_TIMETABLE_GENERATED",
        entity: "TimetableSlot",
        newValue: expect.objectContaining({
          semesterId: "sem-1",
          classSemesterNumber: 3,
          created: 1,
          skippedDueToRaceConflict: 0,
        }),
      })
    );
  });

  it("does NOT send any WhatsApp notification automatically — timetable notifications are manual now", async () => {
    await confirmAutoTimetableBatch(confirmInput);
    expect(sendTimetableNotifications).not.toHaveBeenCalled();
  });
});

const activeSemester = {
  id: "sem-1",
  name: "Semester 1",
  academicYear: { name: "2026-2027" },
  isActive: true,
};

function slotRow(classId: string, className: string) {
  return { id: `slot-${classId}-${Math.random()}`, assignment: { classId, class: { name: className } } };
}

describe("previewClearSemesterTimetable", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.semester.findFirst).mockResolvedValue(activeSemester as never);
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([]);
  });

  it("enforces timetable.generate before querying anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(previewClearSemesterTimetable(3)).rejects.toThrow("FORBIDDEN");
    expect(prisma.timetableSlot.findMany).not.toHaveBeenCalled();
  });

  it("throws NO_ACTIVE_SEMESTER when there's no active semester", async () => {
    vi.mocked(prisma.semester.findFirst).mockResolvedValue(null);

    await expect(previewClearSemesterTimetable(3)).rejects.toThrow("NO_ACTIVE_SEMESTER");
  });

  it("a pure ADMIN queries every class at this level, no dean-scope call at all", async () => {
    await previewClearSemesterTimetable(3);

    expect(getDeanDepartmentIds).not.toHaveBeenCalled();
    expect(prisma.timetableSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { assignment: { semesterId: "sem-1", class: { currentSemesterNumber: 3 } } },
      })
    );
  });

  it("a DEAN's lookup is scoped via classDeanWhere, merged with the semester-level filter", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);

    await previewClearSemesterTimetable(3);

    expect(prisma.timetableSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          assignment: {
            semesterId: "sem-1",
            class: { currentSemesterNumber: 3, program: { departmentId: { in: ["dept-cs"] } } },
          },
        },
      })
    );
  });

  it("aggregates the total and a per-class count, sorted by class name", async () => {
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([
      slotRow("class-2", "CMS26-B-FT"),
      slotRow("class-1", "CMS26-A-FT"),
      slotRow("class-1", "CMS26-A-FT"),
    ] as never);

    const result = await previewClearSemesterTimetable(3);

    expect(result.totalCount).toBe(3);
    expect(result.semesterId).toBe("sem-1");
    expect(result.semesterLabel).toBe("Semester 1 (2026-2027)");
    expect(result.classes).toEqual([
      { classId: "class-1", className: "CMS26-A-FT", count: 2 },
      { classId: "class-2", className: "CMS26-B-FT", count: 1 },
    ]);
  });

  it("returns a zero-count preview when nothing is scheduled at this level", async () => {
    const result = await previewClearSemesterTimetable(3);

    expect(result).toEqual(
      expect.objectContaining({ totalCount: 0, classes: [] })
    );
  });
});

describe("clearSemesterLevelTimetable", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.semester.findFirst).mockResolvedValue(activeSemester as never);
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([
      { id: "slot-1", assignment: { classId: "class-1" } },
      { id: "slot-2", assignment: { classId: "class-1" } },
      { id: "slot-3", assignment: { classId: "class-2" } },
    ] as never);
    vi.mocked(prisma.timetableSlot.deleteMany).mockResolvedValue({ count: 3 } as never);
  });

  it("enforces timetable.generate before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(clearSemesterLevelTimetable(3)).rejects.toThrow("FORBIDDEN");
    expect(prisma.timetableSlot.deleteMany).not.toHaveBeenCalled();
  });

  it("throws NO_ACTIVE_SEMESTER when there's no active semester", async () => {
    vi.mocked(prisma.semester.findFirst).mockResolvedValue(null);

    await expect(clearSemesterLevelTimetable(3)).rejects.toThrow("NO_ACTIVE_SEMESTER");
    expect(prisma.timetableSlot.deleteMany).not.toHaveBeenCalled();
  });

  it("a DEAN's lookup is scoped via classDeanWhere, merged with the semester-level filter", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);

    await clearSemesterLevelTimetable(3);

    expect(prisma.timetableSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          assignment: {
            semesterId: "sem-1",
            class: { currentSemesterNumber: 3, program: { departmentId: { in: ["dept-cs"] } } },
          },
        },
      })
    );
  });

  it("deletes every matching slot in one call, audits TIMETABLE_SEMESTER_CLEARED, and returns the deleted/class counts", async () => {
    const result = await clearSemesterLevelTimetable(3);

    expect(prisma.timetableSlot.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["slot-1", "slot-2", "slot-3"] } },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TIMETABLE_SEMESTER_CLEARED",
        entity: "TimetableSlot",
        entityId: "sem-1",
        oldValue: expect.objectContaining({ semesterId: "sem-1", semesterNumber: 3, deleted: 3, classCount: 2 }),
      })
    );
    expect(result).toEqual({ deleted: 3, classCount: 2 });
  });

  it("never touches LecturerCourseAssignment — only TimetableSlot rows are deleted", async () => {
    await clearSemesterLevelTimetable(3);

    expect(prisma.lecturerCourseAssignment.findMany).not.toHaveBeenCalled();
  });

  it("is a no-op — no delete, no audit — when nothing is scheduled at this level", async () => {
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([]);

    const result = await clearSemesterLevelTimetable(3);

    expect(prisma.timetableSlot.deleteMany).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 0, classCount: 0 });
  });

  it("does NOT send any WhatsApp notification automatically on clear — notifications are manual now", async () => {
    await clearSemesterLevelTimetable(3);

    expect(sendTimetableNotifications).not.toHaveBeenCalled();
  });

  it("revalidates the timetable pages and both workload-import pages, so the pending-assignments card refreshes", async () => {
    const { revalidatePath } = await import("next/cache");

    await clearSemesterLevelTimetable(3);

    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/admin/workload-import");
    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/dean/workload-import");
    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/admin/timetable");
  });
});

describe("saveLecturerAvailableDaysForGeneration", () => {
  const lect1 = { id: "lect-1", fullName: "Dr. Ahmed", availability: [] as { dayOfWeek: string; shift: unknown }[] };
  const lect2 = {
    id: "lect-2",
    fullName: "Dr. Fatima",
    availability: [{ dayOfWeek: "SAT", shift: null }] as { dayOfWeek: string; shift: unknown }[],
  };
  const realShift = { id: "shift-1h", name: "Shift 1", studyMode: "FT", period: "MORNING" };

  function mockTx() {
    const deleteMany = vi.fn();
    const createMany = vi.fn();
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) =>
      (fn as (tx: unknown) => unknown)({ lecturerAvailability: { deleteMany, createMany } })
    );
    return { deleteMany, createMany };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.lecturer.findMany).mockResolvedValue([lect1, lect2] as never);
    vi.mocked(prisma.shift.findMany).mockResolvedValue([realShift] as never);
    mockTx();
  });

  it("enforces the timetable.generate permission before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(
      saveLecturerAvailableDaysForGeneration([{ lecturerId: "lect-1", availability: [{ dayOfWeek: "SAT", shiftIds: [] }] }])
    ).rejects.toThrow("FORBIDDEN");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("is a no-op for an empty update list", async () => {
    const result = await saveLecturerAvailableDaysForGeneration([]);
    expect(result).toEqual({ updated: 0, skipped: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("replaces each lecturer's entire rule set (delete-all then recreate) inside one transaction — day-level-only rows get a null shiftId", async () => {
    const { deleteMany, createMany } = mockTx();

    const result = await saveLecturerAvailableDaysForGeneration([
      {
        lecturerId: "lect-1",
        availability: [
          { dayOfWeek: "SAT", shiftIds: [] },
          { dayOfWeek: "WED", shiftIds: [] },
        ],
      },
      { lecturerId: "lect-2", availability: [] },
    ]);

    expect(result).toEqual({ updated: 2, skipped: 0 });
    expect(deleteMany).toHaveBeenCalledWith({ where: { lecturerId: { in: ["lect-1", "lect-2"] } } });
    expect(createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        { lecturerId: "lect-1", dayOfWeek: "SAT", shiftId: null },
        { lecturerId: "lect-1", dayOfWeek: "WED", shiftId: null },
      ]),
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000, maxWait: 10000 });
  });

  it("writes one row per shift for a day+shift-level restriction, never a null shiftId for that day", async () => {
    const { createMany } = mockTx();

    await saveLecturerAvailableDaysForGeneration([
      { lecturerId: "lect-1", availability: [{ dayOfWeek: "TUE", shiftIds: [realShift.id] }] },
    ]);

    expect(createMany).toHaveBeenCalledWith({
      data: [{ lecturerId: "lect-1", dayOfWeek: "TUE", shiftId: realShift.id }],
    });
  });

  it("silently drops a shift id that doesn't resolve to a real, non-deleted Shift", async () => {
    vi.mocked(prisma.shift.findMany).mockResolvedValue([] as never); // "fake-shift" doesn't exist
    const { createMany } = mockTx();

    await saveLecturerAvailableDaysForGeneration([
      { lecturerId: "lect-1", availability: [{ dayOfWeek: "TUE", shiftIds: ["fake-shift"] }] },
    ]);

    // The day still gets a row, but as day-level-only (empty shiftIds
    // after filtering out the unknown id) rather than a dangling reference.
    expect(createMany).toHaveBeenCalledWith({
      data: [{ lecturerId: "lect-1", dayOfWeek: "TUE", shiftId: null }],
    });
  });

  it("scopes the write to lecturers the dean can actually see, silently skipping the rest", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);
    vi.mocked(prisma.lecturer.findMany).mockResolvedValue([lect1] as never); // lect-2 out of scope

    const result = await saveLecturerAvailableDaysForGeneration([
      { lecturerId: "lect-1", availability: [{ dayOfWeek: "SAT", shiftIds: [] }] },
      { lecturerId: "lect-2", availability: [{ dayOfWeek: "SAT", shiftIds: [] }] },
    ]);

    expect(result).toEqual({ updated: 1, skipped: 1 });
    expect(prisma.lecturer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          assignments: { some: { class: { program: { departmentId: { in: ["dept-cs"] } } } } },
        }),
      })
    );
  });

  it("audits LECTURER_AVAILABLE_DAYS_SET_FOR_GENERATION with old/new per lecturer", async () => {
    await saveLecturerAvailableDaysForGeneration([
      { lecturerId: "lect-1", availability: [{ dayOfWeek: "SAT", shiftIds: [] }, { dayOfWeek: "WED", shiftIds: [] }] },
    ]);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        action: "LECTURER_AVAILABLE_DAYS_SET_FOR_GENERATION",
        entity: "Lecturer",
        oldValue: { lecturers: [{ lecturerId: "lect-1", fullName: "Dr. Ahmed", availability: [] }] },
        newValue: {
          lecturers: [
            {
              lecturerId: "lect-1",
              fullName: "Dr. Ahmed",
              availability: [
                { dayOfWeek: "SAT", shiftIds: [] },
                { dayOfWeek: "WED", shiftIds: [] },
              ],
            },
          ],
        },
      })
    );
  });

  it("overwrites a previous run's value — availability is re-entered fresh every generation cycle", async () => {
    vi.mocked(prisma.lecturer.findMany).mockResolvedValue([lect2] as never); // lect-2 already has [SAT]
    const { createMany, deleteMany } = mockTx();

    await saveLecturerAvailableDaysForGeneration([
      { lecturerId: "lect-2", availability: [{ dayOfWeek: "THU", shiftIds: [] }, { dayOfWeek: "FRI", shiftIds: [] }] },
    ]);

    // The old SAT rule is deleted (delete-all-then-recreate) and never
    // reappears in what's written back.
    expect(deleteMany).toHaveBeenCalledWith({ where: { lecturerId: { in: ["lect-2"] } } });
    expect(createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        { lecturerId: "lect-2", dayOfWeek: "THU", shiftId: null },
        { lecturerId: "lect-2", dayOfWeek: "FRI", shiftId: null },
      ]),
    });
    const created = vi.mocked(createMany).mock.calls[0][0].data as unknown[];
    expect(created).toHaveLength(2); // no leftover SAT row
  });
});

describe("previewSendTimetableBatchNotifications / sendTimetableBatchNotifications", () => {
  const recipients = [
    { type: "STUDENT", id: "s1", name: "Amina", phoneNumber: "+252611111111", className: "CMS26-A-FT", classId: "class-1" },
    { type: "STUDENT", id: "s2", name: "Bashir", phoneNumber: null, className: "CMS26-A-FT", classId: "class-1" },
    { type: "LECTURER", id: "l1", name: "Dr. Ahmed", phoneNumber: "+252633333333", className: "CMS26-A-FT", classId: "class-1" },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.semester.findFirst).mockResolvedValue(activeSemester as never);
    vi.mocked(prisma.class.findMany).mockResolvedValue([
      { id: "class-1", name: "CMS26-A-FT" },
      { id: "class-2", name: "CMS26-B-FT" },
    ] as never);
    vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({ id: "singleton", enabled: true } as never);
    vi.mocked(getRecentTimetableSend).mockResolvedValue({ lastQueuedAt: null, stillPending: 0 });
    vi.mocked(resolveTimetableNotificationRecipients).mockResolvedValue({
      recipients,
      studentCount: 2,
      lecturerCount: 1,
      perClass: [
        { classId: "class-1", className: "CMS26-A-FT", studentCount: 2 },
        { classId: "class-2", className: "CMS26-B-FT", studentCount: 0 },
      ],
    } as never);
    vi.mocked(sendTimetableNotifications).mockResolvedValue({
      enqueuedStudents: 1,
      enqueuedLecturers: 1,
      skipped: 1,
    });
  });

  it("enforces timetable.generate", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(sendTimetableBatchNotifications(3)).rejects.toThrow("FORBIDDEN");
    expect(sendTimetableNotifications).not.toHaveBeenCalled();
  });

  it("only counts classes at this level that actually have a built timetable (assignments.some.timetableSlots.some)", async () => {
    await previewSendTimetableBatchNotifications(3);
    expect(prisma.class.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          currentSemesterNumber: 3,
          assignments: { some: { semesterId: "sem-1", timetableSlots: { some: {} } } },
        }),
      })
    );
  });

  it("a DEAN's class lookup is scoped via classDeanWhere", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);

    await previewSendTimetableBatchNotifications(3);

    expect(prisma.class.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          program: { departmentId: { in: ["dept-cs"] } },
        }),
      })
    );
  });

  it("preview returns per-class + total counts and the with-phone count", async () => {
    const preview = await previewSendTimetableBatchNotifications(3);
    expect(preview).toMatchObject({
      semesterNumber: 3,
      classCount: 2,
      studentCount: 2,
      lecturerCount: 1,
      withPhoneCount: 2,
      whatsappEnabled: true,
      lastQueuedAt: null,
    });
    expect(preview.classes).toHaveLength(2);
  });

  it("send fans out to sendTimetableNotifications and audits TIMETABLE_NOTIFICATIONS_SENT (batch scope)", async () => {
    const result = await sendTimetableBatchNotifications(3);

    expect(sendTimetableNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        recipients,
        changeSummary: expect.any(String),
      })
    );
    expect(result).toMatchObject({ enqueuedStudents: 1, enqueuedLecturers: 1, classCount: 2, whatsappEnabled: true });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TIMETABLE_NOTIFICATIONS_SENT",
        entity: "Semester",
        entityId: "sem-1",
        newValue: expect.objectContaining({ scope: "batch", semesterNumber: 3, classCount: 2, resent: false }),
      })
    );
  });

  it("is a no-op when no class at the level has a built timetable", async () => {
    vi.mocked(prisma.class.findMany).mockResolvedValue([] as never);

    const result = await sendTimetableBatchNotifications(3);

    expect(result).toMatchObject({ enqueuedStudents: 0, enqueuedLecturers: 0, classCount: 0 });
    expect(sendTimetableNotifications).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("refuses a repeat send within the guard window unless force is passed", async () => {
    vi.mocked(getRecentTimetableSend).mockResolvedValue({
      lastQueuedAt: new Date().toISOString(),
      stillPending: 5,
    });

    await expect(sendTimetableBatchNotifications(3)).rejects.toThrow("RECENTLY_SENT");
    expect(sendTimetableNotifications).not.toHaveBeenCalled();

    await sendTimetableBatchNotifications(3, true);
    expect(sendTimetableNotifications).toHaveBeenCalledTimes(1);
  });
});

describe("Timetable Ready — previewSendTimetableReady / sendTimetableReadyToLecturer / sendTimetableReadyBatch", () => {
  const slot = (lecturerId: string, fullName: string, phoneNumber: string | null) => ({
    assignment: {
      lecturerId,
      lecturer: { fullName, phoneNumber, department: { name: "Faculty of Computing" } },
      class: { program: { department: { name: "Faculty of Computing" } } },
    },
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.semester.findFirst).mockResolvedValue(activeSemester as never);
    vi.mocked(prisma.class.findMany).mockResolvedValue([{ id: "class-1", name: "CMS26-A-FT" }] as never);
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([
      slot("lect-1", "Dr. Amina", "+252611111111"),
      slot("lect-2", "Dr. Bashir", null),
    ] as never);
    vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({
      id: "singleton",
      enabled: true,
      domainName: "sams.university.edu",
    } as never);
    vi.mocked(prisma.lecturerTimetableNotification.findMany).mockResolvedValue([]);
    vi.mocked(prisma.lecturerTimetableNotification.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.lecturerTimetableNotification.upsert).mockResolvedValue({} as never);
    vi.mocked(sendTimetableReady).mockResolvedValue({ enqueued: true });
  });

  it("enforces timetable.generate", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(previewSendTimetableReady(3)).rejects.toThrow("FORBIDDEN");
    await expect(sendTimetableReadyToLecturer("lect-1", 3)).rejects.toThrow("FORBIDDEN");
  });

  it("preview lists batch lecturers with hasPhone + notifiedAt, and counts only phone-and-unsent as eligible", async () => {
    const when = new Date("2026-09-01T09:00:00.000Z");
    vi.mocked(prisma.lecturerTimetableNotification.findMany).mockResolvedValue([
      { lecturerId: "lect-1", notifiedAt: when },
    ] as never);

    const preview = await previewSendTimetableReady(3);

    expect(preview.lecturers).toEqual([
      { lecturerId: "lect-1", fullName: "Dr. Amina", hasPhone: true, notifiedAt: when.toISOString() },
      { lecturerId: "lect-2", fullName: "Dr. Bashir", hasPhone: false, notifiedAt: null },
    ]);
    // lect-1 already notified, lect-2 has no phone -> 0 eligible
    expect(preview.eligibleCount).toBe(0);
    expect(preview).toMatchObject({ whatsappEnabled: true, domainConfigured: true, semesterId: "sem-1" });
  });

  it("a DEAN's batch is scoped via classDeanWhere", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);
    await previewSendTimetableReady(3);
    expect(prisma.class.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ program: { departmentId: { in: ["dept-cs"] } } }),
      })
    );
  });

  it("sendTimetableReadyToLecturer rejects a lecturer not teaching in the batch (scope check)", async () => {
    await expect(sendTimetableReadyToLecturer("lect-999", 3)).rejects.toThrow("LECTURER_NOT_IN_BATCH");
    expect(sendTimetableReady).not.toHaveBeenCalled();
  });

  it("sendTimetableReadyToLecturer throws DOMAIN_NOT_CONFIGURED when no login domain is set", async () => {
    vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({
      id: "singleton",
      enabled: true,
      domainName: null,
    } as never);
    await expect(sendTimetableReadyToLecturer("lect-1", 3)).rejects.toThrow("DOMAIN_NOT_CONFIGURED");
  });

  it("sendTimetableReadyToLecturer: enqueues, records sent-state, audits LECTURER_TIMETABLE_READY_SENT — and NEVER touches the credentials flow", async () => {
    const res = await sendTimetableReadyToLecturer("lect-1", 3);

    expect(res.status).toBe("sent");
    expect(sendTimetableReady).toHaveBeenCalledWith(
      expect.objectContaining({
        lecturerId: "lect-1",
        semesterId: "sem-1",
        semesterName: "Semester 1",
        academicYear: "2026-2027",
        domainName: "sams.university.edu",
        facultyName: "Faculty of Computing",
      })
    );
    expect(prisma.lecturerTimetableNotification.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { lecturerId_semesterId: { lecturerId: "lect-1", semesterId: "sem-1" } },
      })
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "LECTURER_TIMETABLE_READY_SENT",
        entity: "Lecturer",
        entityId: "lect-1",
        newValue: expect.objectContaining({ semesterId: "sem-1", resent: false }),
      })
    );
    // Independence: no credential audit, no user mutation anywhere.
    expect(vi.mocked(audit).mock.calls.every(([c]) => c.action !== "LECTURER_CREDENTIALS_SENT")).toBe(true);
  });

  it("marks a resend (existing sent-state row) as resent:true in the audit", async () => {
    vi.mocked(prisma.lecturerTimetableNotification.findUnique).mockResolvedValue({ id: "n1" } as never);

    await sendTimetableReadyToLecturer("lect-1", 3);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "LECTURER_TIMETABLE_READY_SENT", newValue: expect.objectContaining({ resent: true }) })
    );
  });

  it("does not record sent-state / audit when nothing was enqueued (no phone or feature off)", async () => {
    vi.mocked(sendTimetableReady).mockResolvedValue({ enqueued: false });

    const res = await sendTimetableReadyToLecturer("lect-1", 3);

    expect(res.status).toBe("no_phone_or_disabled");
    expect(prisma.lecturerTimetableNotification.upsert).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("sendTimetableReadyBatch targets ONLY eligible lecturers (phone + not yet notified), one enqueue each", async () => {
    // lect-3 also teaches; already notified. lect-2 has no phone. Only lect-1 is eligible.
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([
      slot("lect-1", "Dr. Amina", "+252611111111"),
      slot("lect-2", "Dr. Bashir", null),
      slot("lect-3", "Dr. Cabdi", "+252633333333"),
    ] as never);
    vi.mocked(prisma.lecturerTimetableNotification.findMany).mockResolvedValue([
      { lecturerId: "lect-3" },
    ] as never);

    const { results } = await sendTimetableReadyBatch(3);

    expect(results).toEqual([{ lecturerId: "lect-1", fullName: "Dr. Amina", status: "sent" }]);
    expect(sendTimetableReady).toHaveBeenCalledTimes(1);
    expect(sendTimetableReady).toHaveBeenCalledWith(expect.objectContaining({ lecturerId: "lect-1" }));
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "LECTURER_TIMETABLE_READY_SENT", entityId: "lect-1" }));
  });

  it("sendTimetableReadyBatch throws DOMAIN_NOT_CONFIGURED before sending anything", async () => {
    vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({
      id: "singleton",
      enabled: true,
      domainName: null,
    } as never);
    await expect(sendTimetableReadyBatch(3)).rejects.toThrow("DOMAIN_NOT_CONFIGURED");
    expect(sendTimetableReady).not.toHaveBeenCalled();
  });
});
