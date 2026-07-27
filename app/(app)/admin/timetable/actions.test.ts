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
    lecturerCourseAssignment: { findFirst: vi.fn() },
    timetableSlot: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("@/lib/dean-scope", () => ({
  getDeanDepartmentIds: vi.fn(),
  assignmentDeanWhere: vi.fn((ids: string[]) => ({
    class: { program: { departmentId: { in: ids } } },
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
