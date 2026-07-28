import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    timetableSlot: { findMany: vi.fn() },
    lecturerCourseAssignment: { findMany: vi.fn() },
    room: { findMany: vi.fn() },
    campus: { findMany: vi.fn() },
    shift: { findMany: vi.fn() },
    class: { findMany: vi.fn() },
    lecturer: { findMany: vi.fn() },
    semester: { findMany: vi.fn() },
    studentCourseEnrollment: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({
  getUserAccess: vi.fn(),
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

import { prisma } from "@/lib/db";
import { getUserAccess } from "@/lib/auth";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import {
  buildTimetableWhere,
  getTimetablePanelData,
  getSlotsForExport,
  getMyTimetableForLecturer,
  getMyTimetableForStudent,
} from "./queries";

describe("buildTimetableWhere", () => {
  it("returns an empty where when no scope or filters are given", () => {
    expect(buildTimetableWhere({})).toEqual({});
  });

  it("ANDs the scope with every active filter", () => {
    const where = buildTimetableWhere(
      {
        classId: "class-1",
        lecturerId: "lect-1",
        roomId: "room-1",
        campusId: "campus-1",
        semesterId: "sem-1",
      },
      { assignment: { class: { program: { departmentId: { in: ["dept-cs"] } } } } }
    );

    expect(where).toEqual({
      AND: [
        { assignment: { class: { program: { departmentId: { in: ["dept-cs"] } } } } },
        { assignment: { classId: "class-1" } },
        { assignment: { lecturerId: "lect-1" } },
        { roomId: "room-1" },
        { room: { campusId: "campus-1" } },
        { assignment: { semesterId: "sem-1" } },
      ],
    });
  });

  it("filters by campus via the room's campusId", () => {
    const where = buildTimetableWhere({ campusId: "campus-1" });
    expect(where).toEqual({ AND: [{ room: { campusId: "campus-1" } }] });
  });

  it("a filter outside the scope still ANDs in, so it just yields zero rows rather than escaping the scope", () => {
    const where = buildTimetableWhere(
      { classId: "class-outside" },
      { assignment: { class: { program: { departmentId: { in: ["dept-cs"] } } } } }
    );
    expect(where).toEqual({
      AND: [
        { assignment: { class: { program: { departmentId: { in: ["dept-cs"] } } } } },
        { assignment: { classId: "class-outside" } },
      ],
    });
  });
});

function mockRoles(roleNames: string[]) {
  vi.mocked(getUserAccess).mockResolvedValue({
    permissions: new Set(),
    roleNames,
  } as never);
}

describe("getTimetablePanelData", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([]);
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([]);
    vi.mocked(prisma.room.findMany).mockResolvedValue([]);
    vi.mocked(prisma.campus.findMany).mockResolvedValue([]);
    vi.mocked(prisma.shift.findMany).mockResolvedValue([]);
    vi.mocked(prisma.class.findMany).mockResolvedValue([]);
    vi.mocked(prisma.lecturer.findMany).mockResolvedValue([]);
    vi.mocked(prisma.semester.findMany).mockResolvedValue([]);
  });

  it("a pure ADMIN sees every slot/assignment/class, no dean-scope call at all", async () => {
    mockRoles(["ADMIN"]);

    const data = await getTimetablePanelData("admin-1", {});

    expect(getDeanDepartmentIds).not.toHaveBeenCalled();
    expect(data.unassigned).toBe(false);
    expect(prisma.timetableSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} })
    );
    expect(prisma.lecturerCourseAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} })
    );
    expect(prisma.class.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } })
    );
  });

  it("a DEAN is scoped to their own dean_departments for slots, assignments, and classes", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);

    const data = await getTimetablePanelData("dean-1", {});

    expect(data.unassigned).toBe(false);
    expect(prisma.timetableSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            { assignment: { class: { program: { departmentId: { in: ["dept-cs"] } } } } },
          ],
        },
      })
    );
    expect(prisma.lecturerCourseAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { class: { program: { departmentId: { in: ["dept-cs"] } } } },
      })
    );
    expect(prisma.class.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: null, program: { departmentId: { in: ["dept-cs"] } } },
      })
    );
  });

  it("an unassigned DEAN gets the empty/unassigned shape without querying slots", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue([]);

    const data = await getTimetablePanelData("dean-2", {});

    expect(data).toEqual({
      slots: [],
      assignments: [],
      rooms: [],
      campuses: [],
      shifts: [],
      semesters: [],
      classes: [],
      lecturers: [],
      activeSemesterId: "",
      unassigned: true,
    });
    expect(prisma.timetableSlot.findMany).not.toHaveBeenCalled();
  });

  it("fetches campuses unscoped, like rooms — no dean_departments filter applied", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);

    await getTimetablePanelData("dean-1", {});

    expect(prisma.campus.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } })
    );
  });

  it("fetches shifts unscoped, like campuses/rooms — any timetable.manage holder can pick from the full list", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);

    await getTimetablePanelData("dean-1", {});

    expect(prisma.shift.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } })
    );
  });

  it("applies the campusId filter to the slot query via the room's campusId", async () => {
    mockRoles(["ADMIN"]);

    await getTimetablePanelData("admin-1", { campusId: "campus-1", semesterId: "all" });

    expect(prisma.timetableSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{ room: { campusId: "campus-1" } }] },
      })
    );
  });

  it("a DEAN+ADMIN multi-role user is still scoped as a DEAN — role check, not permission check", async () => {
    mockRoles(["ADMIN", "DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);

    const data = await getTimetablePanelData("multi-1", {});

    expect(data.unassigned).toBe(false);
    expect(prisma.lecturerCourseAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { class: { program: { departmentId: { in: ["dept-cs"] } } } },
      })
    );
  });

  it("defaults the slot filter to the active semester when no semesterId param is given", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.semester.findMany).mockResolvedValue([
      { id: "sem-old", isActive: false },
      { id: "sem-active", isActive: true },
    ] as never);

    const data = await getTimetablePanelData("admin-1", {});

    expect(data.activeSemesterId).toBe("sem-active");
    expect(prisma.timetableSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{ assignment: { semesterId: "sem-active" } }] },
      })
    );
  });

  it('an explicit semesterId of "all" drops the semester filter entirely', async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.semester.findMany).mockResolvedValue([
      { id: "sem-active", isActive: true },
    ] as never);

    await getTimetablePanelData("admin-1", { semesterId: "all" });

    expect(prisma.timetableSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} })
    );
  });

  it("the assignment picker is NOT filtered by the grid's semester filter", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.semester.findMany).mockResolvedValue([
      { id: "sem-active", isActive: true },
      { id: "sem-other", isActive: false },
    ] as never);

    await getTimetablePanelData("admin-1", { semesterId: "sem-other" });

    // slots ARE filtered to sem-other, but assignments (the Add/Edit
    // dialog's picker) call has no semesterId condition at all.
    expect(prisma.timetableSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{ assignment: { semesterId: "sem-other" } }] },
      })
    );
    expect(prisma.lecturerCourseAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} })
    );
  });
});

describe("getSlotsForExport", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([]);
    vi.mocked(prisma.semester.findMany).mockResolvedValue([]);
  });

  it("a pure ADMIN gets every matching slot, no dean-scope call at all", async () => {
    mockRoles(["ADMIN"]);

    await getSlotsForExport("admin-1", {});

    expect(getDeanDepartmentIds).not.toHaveBeenCalled();
    expect(prisma.timetableSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} })
    );
  });

  it("a DEAN is scoped to their own dean_departments, identically to the panel query", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);

    await getSlotsForExport("dean-1", { roomId: "room-1" });

    expect(prisma.timetableSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            { assignment: { class: { program: { departmentId: { in: ["dept-cs"] } } } } },
            { roomId: "room-1" },
          ],
        },
      })
    );
  });

  it("an unassigned DEAN gets an empty export without ever querying slots", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue([]);

    const result = await getSlotsForExport("dean-2", {});

    expect(result).toEqual([]);
    expect(prisma.timetableSlot.findMany).not.toHaveBeenCalled();
  });

  it("defaults to the active semester exactly like the panel query", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.semester.findMany).mockResolvedValue([
      { id: "sem-old", isActive: false },
      { id: "sem-active", isActive: true },
    ] as never);

    await getSlotsForExport("admin-1", {});

    expect(prisma.timetableSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{ assignment: { semesterId: "sem-active" } }] },
      })
    );
  });

  it('an explicit semesterId of "all" drops the semester filter entirely', async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.semester.findMany).mockResolvedValue([
      { id: "sem-active", isActive: true },
    ] as never);

    await getSlotsForExport("admin-1", { semesterId: "all" });

    expect(prisma.timetableSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} })
    );
  });
});

describe("getMyTimetableForLecturer", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([]);
  });

  it("scopes to slots whose assignment's lecturer is this user — the query IS the ownership check", async () => {
    await getMyTimetableForLecturer("lecturer-user-1");

    expect(prisma.timetableSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { assignment: { lecturer: { userId: "lecturer-user-1" } } },
      })
    );
  });
});

describe("getMyTimetableForStudent", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([]);
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([]);
  });

  it("resolves the student's own ACTIVE enrollments first, scoped through student.userId", async () => {
    await getMyTimetableForStudent("student-user-1");

    expect(prisma.studentCourseEnrollment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { student: { userId: "student-user-1" }, status: "ACTIVE" },
      })
    );
  });

  it("a student with no active enrollments gets an empty schedule without ever querying slots", async () => {
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([]);

    const result = await getMyTimetableForStudent("student-user-1");

    expect(result).toEqual([]);
    expect(prisma.timetableSlot.findMany).not.toHaveBeenCalled();
  });

  it("matches slots via the exact course+class+semester tuples from the student's own enrollments", async () => {
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([
      { courseId: "course-1", classId: "class-1", semesterId: "sem-1" },
      { courseId: "course-2", classId: "class-1", semesterId: "sem-1" },
    ] as never);

    await getMyTimetableForStudent("student-user-1");

    expect(prisma.timetableSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          assignment: {
            OR: [
              { courseId: "course-1", classId: "class-1", semesterId: "sem-1" },
              { courseId: "course-2", classId: "class-1", semesterId: "sem-1" },
            ],
          },
        },
      })
    );
  });
});
