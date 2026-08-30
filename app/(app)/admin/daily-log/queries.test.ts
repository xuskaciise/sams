import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    dailyLogEntry: { findMany: vi.fn(), count: vi.fn(), aggregate: vi.fn() },
    department: { findMany: vi.fn() },
    lecturer: { findMany: vi.fn() },
    student: { findMany: vi.fn(), findUnique: vi.fn() },
    semester: { findFirst: vi.fn() },
    timetableSlot: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({
  getUserAccess: vi.fn(),
}));

vi.mock("@/lib/dean-scope", () => ({
  getDeanDepartmentIds: vi.fn(),
  dailyLogDeanWhere: vi.fn((ids: string[]) => ({ departmentId: { in: ids } })),
  studentDeanWhere: vi.fn((ids: string[]) => ({
    class: { program: { departmentId: { in: ids } } },
  })),
}));

import { prisma } from "@/lib/db";
import { getUserAccess } from "@/lib/auth";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import {
  buildDailyLogWhere,
  getDailyLogPanelData,
  getMyLeaveNotices,
  getMyLeaveNoticesForStudent,
  getMyLeaveHoursSummary,
  fetchLeaveSessionSlots,
  toLeaveNoticeSessionOptions,
} from "./queries";

describe("buildDailyLogWhere", () => {
  it("returns an empty where when no scope or filters are given", () => {
    expect(buildDailyLogWhere({})).toEqual({});
  });

  it("ANDs the scope with every active filter", () => {
    const where = buildDailyLogWhere(
      { departmentId: "dept-cs", type: "PROBLEM", q: "projector" },
      { departmentId: { in: ["dept-cs", "dept-eng"] } }
    );

    expect(where).toEqual({
      AND: [
        { departmentId: { in: ["dept-cs", "dept-eng"] } },
        { departmentId: "dept-cs" },
        { type: "PROBLEM" },
        {
          OR: [
            { title: { contains: "projector", mode: "insensitive" } },
            { description: { contains: "projector", mode: "insensitive" } },
          ],
        },
      ],
    });
  });

  it("filters entryDate to the given single day", () => {
    const where = buildDailyLogWhere({ date: "2026-07-22" });
    expect(where).toEqual({
      AND: [
        {
          entryDate: {
            gte: new Date("2026-07-22T00:00:00.000Z"),
            lte: new Date("2026-07-22T23:59:59.999Z"),
          },
        },
      ],
    });
  });

  it("a filter outside the scope still ANDs in, so it just yields zero rows rather than escaping the scope", () => {
    const where = buildDailyLogWhere(
      { departmentId: "dept-outside" },
      { departmentId: { in: ["dept-cs"] } }
    );
    expect(where).toEqual({
      AND: [
        { departmentId: { in: ["dept-cs"] } },
        { departmentId: "dept-outside" },
      ],
    });
  });
});

describe("getDailyLogPanelData", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.dailyLogEntry.findMany).mockResolvedValue([]);
    vi.mocked(prisma.dailyLogEntry.count).mockResolvedValue(0);
    vi.mocked(prisma.department.findMany).mockResolvedValue([]);
    vi.mocked(prisma.lecturer.findMany).mockResolvedValue([]);
    vi.mocked(prisma.student.findMany).mockResolvedValue([]);
  });

  it("a pure ADMIN sees every non-deleted department and every active lecturer — no dean-scope call at all", async () => {
    vi.mocked(getUserAccess).mockResolvedValue({
      permissions: new Set(),
      roleNames: ["ADMIN"],
    } as never);

    const data = await getDailyLogPanelData("admin-1", {});

    expect(getDeanDepartmentIds).not.toHaveBeenCalled();
    expect(data.unassigned).toBe(false);
    expect(prisma.department.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } })
    );
    expect(prisma.lecturer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { OR: [{ userId: null }, { user: { deletedAt: null } }] } })
    );
    expect(prisma.student.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} })
    );
    expect(prisma.dailyLogEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} })
    );
  });

  it("a DEAN is scoped to their own dean_departments for entries and the department list", async () => {
    vi.mocked(getUserAccess).mockResolvedValue({
      permissions: new Set(),
      roleNames: ["DEAN"],
    } as never);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);

    const data = await getDailyLogPanelData("dean-1", {});

    expect(data.unassigned).toBe(false);
    expect(prisma.dailyLogEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{ departmentId: { in: ["dept-cs"] } }] },
      })
    );
    expect(prisma.department.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["dept-cs"] } } })
    );
  });

  it("the lecturer list is NEVER dean-scoped, even for a DEAN — every active lecturer is offered, since a faculty with zero current assignments would otherwise show none", async () => {
    vi.mocked(getUserAccess).mockResolvedValue({
      permissions: new Set(),
      roleNames: ["DEAN"],
    } as never);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);

    await getDailyLogPanelData("dean-1", {});

    expect(prisma.lecturer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { OR: [{ userId: null }, { user: { deletedAt: null } }] } })
    );
  });

  it("the student list IS dean-scoped via studentDeanWhere — unlike lecturers, every student has a real home department", async () => {
    vi.mocked(getUserAccess).mockResolvedValue({
      permissions: new Set(),
      roleNames: ["DEAN"],
    } as never);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);

    await getDailyLogPanelData("dean-1", {});

    expect(prisma.student.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { class: { program: { departmentId: { in: ["dept-cs"] } } } },
      })
    );
  });

  it("an unassigned DEAN gets the empty/unassigned shape without ever querying entries", async () => {
    vi.mocked(getUserAccess).mockResolvedValue({
      permissions: new Set(),
      roleNames: ["DEAN"],
    } as never);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue([]);

    const data = await getDailyLogPanelData("dean-2", {});

    expect(data).toEqual({
      entries: [],
      total: 0,
      page: 1,
      pageSize: 10,
      departments: [],
      lecturers: [],
      students: [],
      unassigned: true,
    });
    expect(prisma.dailyLogEntry.findMany).not.toHaveBeenCalled();
  });

  it("a DEAN+ADMIN multi-role user is still scoped as a DEAN — role check, not permission check", async () => {
    vi.mocked(getUserAccess).mockResolvedValue({
      permissions: new Set(),
      roleNames: ["ADMIN", "DEAN"],
    } as never);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);

    const data = await getDailyLogPanelData("multi-1", {});

    expect(data.unassigned).toBe(false);
    expect(prisma.department.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["dept-cs"] } } })
    );
  });
});

describe("getMyLeaveNotices", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.dailyLogEntry.findMany).mockResolvedValue([]);
  });

  it("scopes to LEAVE_NOTICE entries naming this lecturer — the query IS the ownership check", async () => {
    await getMyLeaveNotices("lecturer-user-1");

    expect(prisma.dailyLogEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          type: "LEAVE_NOTICE",
          relatedLecturer: { userId: "lecturer-user-1" },
        },
      })
    );
  });

  it("defaults to the 5 most recent, but accepts a custom limit", async () => {
    await getMyLeaveNotices("lecturer-user-1");
    expect(prisma.dailyLogEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5, orderBy: { entryDate: "desc" } })
    );

    await getMyLeaveNotices("lecturer-user-1", 10);
    expect(prisma.dailyLogEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10 })
    );
  });
});

// Regression test: a real LEAVE_NOTICE entry with relatedStudentId
// pointing at a student must actually surface for that student's
// session. Root cause of the original bug report was that no
// student-facing query existed at all (relatedStudentId was wired up
// for the ADMIN/DEAN list and the create form, but never read back out
// for a student) — this pins the fix in place.
describe("getMyLeaveNoticesForStudent", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.dailyLogEntry.findMany).mockResolvedValue([]);
  });

  it("scopes to LEAVE_NOTICE entries naming this student — the query IS the ownership check", async () => {
    await getMyLeaveNoticesForStudent("student-user-1");

    expect(prisma.dailyLogEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          type: "LEAVE_NOTICE",
          relatedStudent: { userId: "student-user-1" },
        },
      })
    );
  });

  it("returns a real LEAVE_NOTICE row when the student it names is querying — the actual reported bug", async () => {
    const entry = {
      id: "entry-1",
      type: "LEAVE_NOTICE",
      title: "Leave notice — ahmed",
      relatedStudentId: "student-1",
      department: { name: "Health Science" },
      author: { fullName: "Dean User" },
      leaveHours: null,
      sessions: [],
    };
    vi.mocked(prisma.dailyLogEntry.findMany).mockResolvedValue([entry] as never);

    const result = await getMyLeaveNoticesForStudent("student-user-1");

    // leaveHours is passed through as-is (null), sessions serialized to [].
    expect(result).toEqual([{ ...entry, leaveHours: null, sessions: [] }]);
  });

  it("serializes a linked session's Decimal hours to a plain number and the entry's leaveHours snapshot", async () => {
    vi.mocked(prisma.dailyLogEntry.findMany).mockResolvedValue([
      {
        id: "entry-2",
        type: "LEAVE_NOTICE",
        relatedStudentId: "student-1",
        department: { name: "Eng" },
        author: { fullName: "Dean" },
        leaveHours: { toString: () => "3", valueOf: () => 3 },
        sessions: [
          {
            id: "s1",
            timetableSlotId: "slot-1",
            courseName: "Physics",
            className: "CS-1",
            startTime: "09:00",
            endTime: "10:30",
            hours: { toString: () => "1.5", valueOf: () => 1.5 },
          },
        ],
      },
    ] as never);

    const [row] = await getMyLeaveNoticesForStudent("student-user-1");

    expect(row.leaveHours).toBe(3);
    expect(row.sessions).toEqual([
      {
        id: "s1",
        timetableSlotId: "slot-1",
        courseName: "Physics",
        className: "CS-1",
        startTime: "09:00",
        endTime: "10:30",
        hours: 1.5,
      },
    ]);
  });

  it("defaults to the 5 most recent, but accepts a custom limit", async () => {
    await getMyLeaveNoticesForStudent("student-user-1");
    expect(prisma.dailyLogEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5, orderBy: { entryDate: "desc" } })
    );

    await getMyLeaveNoticesForStudent("student-user-1", 10);
    expect(prisma.dailyLogEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10 })
    );
  });
});

describe("fetchLeaveSessionSlots", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.timetableSlot.findMany).mockResolvedValue([]);
    vi.mocked(prisma.student.findUnique).mockResolvedValue({
      classId: "class-1",
    } as never);
  });

  it("returns [] for an unparseable / missing date without touching the DB", async () => {
    const result = await fetchLeaveSessionSlots({
      relatedLecturerId: "lect-1",
      entryDate: "",
    });
    expect(result).toEqual([]);
    expect(prisma.timetableSlot.findMany).not.toHaveBeenCalled();
  });

  it("for a lecturer: every session they teach that day, in the active semester", async () => {
    // 2026-08-31 is a Monday.
    await fetchLeaveSessionSlots({
      relatedLecturerId: "lect-1",
      entryDate: "2026-08-31",
    });

    expect(prisma.timetableSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          dayOfWeek: "MON",
          assignment: {
            lecturerId: "lect-1",
            semester: { isActive: true },
          },
        },
        orderBy: { startTime: "asc" },
      })
    );
  });

  it("for a student: their own class's sessions that day, resolved via the student's classId", async () => {
    // 2026-08-30 is a Sunday.
    await fetchLeaveSessionSlots({
      relatedStudentId: "student-1",
      entryDate: "2026-08-30",
    });

    expect(prisma.student.findUnique).toHaveBeenCalledWith({
      where: { id: "student-1" },
      select: { classId: true },
    });
    expect(prisma.timetableSlot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          dayOfWeek: "SUN",
          assignment: {
            classId: "class-1",
            semester: { isActive: true },
          },
        },
      })
    );
  });

  it("returns [] for a student id that doesn't resolve", async () => {
    vi.mocked(prisma.student.findUnique).mockResolvedValue(null as never);
    const result = await fetchLeaveSessionSlots({
      relatedStudentId: "ghost",
      entryDate: "2026-08-31",
    });
    expect(result).toEqual([]);
    expect(prisma.timetableSlot.findMany).not.toHaveBeenCalled();
  });
});

describe("toLeaveNoticeSessionOptions", () => {
  it("maps slots to {course, class, time, hours} with the duration computed from the slot's own times", () => {
    const options = toLeaveNoticeSessionOptions([
      {
        id: "slot-1",
        startTime: "09:00",
        endTime: "10:30",
        assignment: {
          course: { name: "Physics" },
          class: { name: "CS-1" },
        },
      },
      {
        id: "slot-2",
        startTime: "11:00",
        endTime: "13:30",
        assignment: {
          course: { name: "Chemistry" },
          class: { name: "CS-1" },
        },
      },
    ] as never);

    expect(options).toEqual([
      {
        id: "slot-1",
        courseName: "Physics",
        className: "CS-1",
        startTime: "09:00",
        endTime: "10:30",
        hours: 1.5,
      },
      {
        id: "slot-2",
        courseName: "Chemistry",
        className: "CS-1",
        startTime: "11:00",
        endTime: "13:30",
        hours: 2.5,
      },
    ]);
  });
});

describe("getMyLeaveHoursSummary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.dailyLogEntry.count).mockResolvedValue(3 as never);
  });

  it("sums the stored leaveHours snapshot, scoped to the active semester's date range", async () => {
    vi.mocked(prisma.semester.findFirst).mockResolvedValue({
      startDate: new Date("2026-08-01T00:00:00.000Z"),
      endDate: new Date("2026-12-31T00:00:00.000Z"),
    } as never);
    vi.mocked(prisma.dailyLogEntry.aggregate).mockResolvedValue({
      _sum: { leaveHours: { valueOf: () => 12.5 } },
    } as never);

    const result = await getMyLeaveHoursSummary("lect-user-1");

    expect(result).toEqual({
      totalHours: 12.5,
      entryCount: 3,
      scopedToSemester: true,
    });
    expect(prisma.dailyLogEntry.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        _sum: { leaveHours: true },
        where: expect.objectContaining({
          type: "LEAVE_NOTICE",
          relatedLecturer: { userId: "lect-user-1" },
          entryDate: {
            gte: new Date("2026-08-01T00:00:00.000Z"),
            lte: new Date("2026-12-31T00:00:00.000Z"),
          },
        }),
      })
    );
  });

  it("falls back to all-time (no date filter) when there's no active semester", async () => {
    vi.mocked(prisma.semester.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.dailyLogEntry.aggregate).mockResolvedValue({
      _sum: { leaveHours: null },
    } as never);

    const result = await getMyLeaveHoursSummary("student-user-1", {
      forStudent: true,
    });

    expect(result).toEqual({
      totalHours: 0,
      entryCount: 3,
      scopedToSemester: false,
    });
    expect(prisma.dailyLogEntry.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          type: "LEAVE_NOTICE",
          relatedStudent: { userId: "student-user-1" },
        },
      })
    );
  });
});
