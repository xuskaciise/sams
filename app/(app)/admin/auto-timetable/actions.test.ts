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
}));

vi.mock("@/lib/whatsapp-notify", () => ({
  notifyTimetableChange: vi.fn(),
}));

vi.mock("../timetable/queries", () => ({
  getConflictCandidates: vi.fn(),
  getShiftOptions: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    lecturerCourseAssignment: { findMany: vi.fn() },
    timetableSlot: { createMany: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
    semester: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
  BULK_TRANSACTION_OPTIONS: { timeout: 30000, maxWait: 10000 },
}));

import { requirePermission, getUserAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import { notifyTimetableChange } from "@/lib/whatsapp-notify";
import { getConflictCandidates, getShiftOptions } from "../timetable/queries";
import {
  previewAutoTimetableBatch,
  confirmAutoTimetableBatch,
  previewClearSemesterTimetable,
  clearSemesterLevelTimetable,
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
  lecturer: { fullName: "Dr. Ahmed", availableDays: [] as string[] },
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

  it("carries the lecturer's availableDays through to the algorithm — a restricted lecturer is only ever scheduled within it", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      { ...assignmentRow, lecturer: { fullName: "Dr. Ahmed", availableDays: ["SAT"] } },
    ] as never);
    const result = await previewAutoTimetableBatch(input);
    expect(result.unscheduled).toHaveLength(0);
    expect(result.scheduledNormally[0].dayOfWeek).toBe("SAT");
  });

  it("reports Unscheduled with the lecturer-restriction reason when availableDays has zero overlap with the class's valid days", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      { ...assignmentRow, lecturer: { fullName: "Dr. Ahmed", availableDays: ["THU", "FRI"] } }, // class is FT
    ] as never);
    const result = await previewAutoTimetableBatch(input);
    expect(result.scheduledNormally).toHaveLength(0);
    expect(result.unscheduled).toHaveLength(1);
    expect(result.unscheduled[0].reason).toContain("Lecturer only available Thu/Fri");
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

  it("sends exactly one WhatsApp timetable-change notification per affected class", async () => {
    await confirmAutoTimetableBatch(confirmInput);
    expect(notifyTimetableChange).toHaveBeenCalledTimes(1);
    expect(notifyTimetableChange).toHaveBeenCalledWith("class-1", expect.stringContaining("auto-generated"));
  });

  it("never sends a notification when nothing was created", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([]);
    await confirmAutoTimetableBatch(confirmInput);
    expect(notifyTimetableChange).not.toHaveBeenCalled();
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

  it("sends exactly one WhatsApp notification per affected class, not per session", async () => {
    await clearSemesterLevelTimetable(3);

    expect(notifyTimetableChange).toHaveBeenCalledTimes(2);
    expect(notifyTimetableChange).toHaveBeenCalledWith("class-1", expect.any(String));
    expect(notifyTimetableChange).toHaveBeenCalledWith("class-2", expect.any(String));
  });

  it("revalidates the timetable pages and both workload-import pages, so the pending-assignments card refreshes", async () => {
    const { revalidatePath } = await import("next/cache");

    await clearSemesterLevelTimetable(3);

    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/admin/workload-import");
    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/dean/workload-import");
    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/admin/timetable");
  });
});
