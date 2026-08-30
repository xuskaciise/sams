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
    lecturer: { findFirst: vi.fn() },
    student: { findFirst: vi.fn() },
    dailyLogEntry: { create: vi.fn() },
    dailyLogEntrySession: { createMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/dean-scope", () => ({
  getDeanDepartmentIds: vi.fn(),
  studentDeanWhere: vi.fn((ids: string[]) => ({
    class: { program: { departmentId: { in: ids } } },
  })),
}));

vi.mock("@/lib/whatsapp-notify", () => ({
  notifyLeaveNotice: vi.fn(),
}));

vi.mock("./queries", () => ({
  fetchLeaveSessionSlots: vi.fn(),
  toLeaveNoticeSessionOptions: vi.fn(),
}));

import { requirePermission, getUserAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import { notifyLeaveNotice } from "@/lib/whatsapp-notify";
import { fetchLeaveSessionSlots } from "./queries";
import { createDailyLogEntry } from "./actions";

const lecturer = {
  id: "lect-1",
  fullName: "Dr. Ahmed",
};

const student = {
  id: "student-1",
  studentNo: "S1001",
  fullName: "Jane Doe",
};

function mockRoles(roleNames: string[]) {
  vi.mocked(getUserAccess).mockResolvedValue({
    permissions: new Set(),
    roleNames,
  } as never);
}

describe("createDailyLogEntry", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.dailyLogEntry.create).mockResolvedValue({
      id: "entry-1",
      departmentId: "dept-cs",
      type: "NOTE",
      relatedLecturerId: null,
      title: "Broken projector",
    } as never);
    // The transaction path (only taken when there are session rows) runs
    // the callback against a tx that mirrors the same two models.
    vi.mocked(prisma.$transaction).mockImplementation(
      ((fn: (tx: unknown) => unknown) =>
        Promise.resolve(
          fn({
            dailyLogEntry: {
              create: vi.fn().mockResolvedValue({
                id: "entry-1",
                departmentId: "dept-cs",
                type: "LEAVE_NOTICE",
                relatedLecturerId: "lect-1",
                relatedStudentId: null,
                title: "Leave notice — Dr. Ahmed",
              }),
            },
            dailyLogEntrySession: { createMany: vi.fn() },
          })
        )) as never
    );
  });

  it("enforces dailylog.create before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(
      createDailyLogEntry({
        departmentId: "dept-cs",
        type: "NOTE",
        title: "x",
        entryDate: "2026-07-22",
      })
    ).rejects.toThrow("FORBIDDEN");
    expect(prisma.dailyLogEntry.create).not.toHaveBeenCalled();
  });

  it("a pure ADMIN can create an entry in any department, no dean-scope check at all", async () => {
    mockRoles(["ADMIN"]);

    await createDailyLogEntry({
      departmentId: "dept-eng",
      type: "NOTE",
      title: "Broken projector",
      entryDate: "2026-07-22",
    });

    expect(getDeanDepartmentIds).not.toHaveBeenCalled();
    expect(prisma.dailyLogEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ departmentId: "dept-eng" }),
    });
  });

  it("a DEAN can create an entry in a department they oversee", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs", "dept-eng"]);

    await createDailyLogEntry({
      departmentId: "dept-eng",
      type: "NOTE",
      title: "Broken projector",
      entryDate: "2026-07-22",
    });

    expect(prisma.dailyLogEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ departmentId: "dept-eng" }),
    });
  });

  it("a DEAN is rejected for a department outside their dean_departments", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);

    await expect(
      createDailyLogEntry({
        departmentId: "dept-eng",
        type: "NOTE",
        title: "Broken projector",
        entryDate: "2026-07-22",
      })
    ).rejects.toThrow("FORBIDDEN_DEPARTMENT");
    expect(prisma.dailyLogEntry.create).not.toHaveBeenCalled();
  });

  it("an unassigned DEAN (empty dean_departments) is rejected for ANY department", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue([]);

    await expect(
      createDailyLogEntry({
        departmentId: "dept-cs",
        type: "NOTE",
        title: "Broken projector",
        entryDate: "2026-07-22",
      })
    ).rejects.toThrow("FORBIDDEN_DEPARTMENT");
  });

  it("a DEAN+ADMIN multi-role user is still treated as a DEAN for scoping", async () => {
    mockRoles(["ADMIN", "DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);

    await expect(
      createDailyLogEntry({
        departmentId: "dept-eng",
        type: "NOTE",
        title: "Broken projector",
        entryDate: "2026-07-22",
      })
    ).rejects.toThrow("FORBIDDEN_DEPARTMENT");
  });

  it("derives the title from the lecturer's name for a LEAVE_NOTICE, ignoring any submitted title", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.lecturer.findFirst).mockResolvedValue(lecturer as never);

    await createDailyLogEntry({
      departmentId: "dept-cs",
      type: "LEAVE_NOTICE",
      relatedLecturerId: "lect-1",
      title: "should be ignored",
      entryDate: "2026-07-22",
    });

    expect(prisma.dailyLogEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        title: "Leave notice — Dr. Ahmed",
        relatedLecturerId: "lect-1",
      }),
    });
    expect(notifyLeaveNotice).toHaveBeenCalledWith("entry-1");
  });

  it("derives the title from the STUDENT's name for a LEAVE_NOTICE about a student — the About toggle applies to LEAVE_NOTICE too", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.student.findFirst).mockResolvedValue(student as never);

    await createDailyLogEntry({
      departmentId: "dept-cs",
      type: "LEAVE_NOTICE",
      relatedStudentId: "student-1",
      entryDate: "2026-07-22",
    });

    expect(prisma.dailyLogEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        title: "Leave notice — Jane Doe",
        relatedStudentId: "student-1",
        relatedLecturerId: null,
      }),
    });
    expect(notifyLeaveNotice).toHaveBeenCalledWith("entry-1");
  });

  it("never notifies for NOTE/PROBLEM entries — only LEAVE_NOTICE does", async () => {
    mockRoles(["ADMIN"]);

    await createDailyLogEntry({
      departmentId: "dept-cs",
      type: "NOTE",
      title: "Broken projector",
      entryDate: "2026-07-22",
    });

    expect(notifyLeaveNotice).not.toHaveBeenCalled();
  });

  it("a DEAN's LEAVE_NOTICE student reference IS scoped via studentDeanWhere, same as for NOTE/PROBLEM", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);
    vi.mocked(prisma.student.findFirst).mockResolvedValue(null);

    await expect(
      createDailyLogEntry({
        departmentId: "dept-cs",
        type: "LEAVE_NOTICE",
        relatedStudentId: "student-outside",
        entryDate: "2026-07-22",
      })
    ).rejects.toThrow("STUDENT_NOT_FOUND");
    expect(prisma.dailyLogEntry.create).not.toHaveBeenCalled();
  });

  it("a DEAN's LEAVE_NOTICE lecturer lookup is NOT scoped to their faculty — any active lecturer is pickable", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);
    vi.mocked(prisma.lecturer.findFirst).mockResolvedValue(lecturer as never);

    await createDailyLogEntry({
      departmentId: "dept-cs",
      type: "LEAVE_NOTICE",
      relatedLecturerId: "lect-1",
      entryDate: "2026-07-22",
    });

    // No department/assignment scoping in this lookup — a lecturer with
    // zero current assignments (a quiet/new faculty) must still be
    // pickable. The entry's own departmentId (checked above) is the real
    // boundary, not which lecturer gets named in it.
    expect(prisma.lecturer.findFirst).toHaveBeenCalledWith({
      where: { id: "lect-1" },
    });
  });

  it("rejects a LEAVE_NOTICE referencing a lecturer id that doesn't exist at all", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);
    vi.mocked(prisma.lecturer.findFirst).mockResolvedValue(null);

    await expect(
      createDailyLogEntry({
        departmentId: "dept-cs",
        type: "LEAVE_NOTICE",
        relatedLecturerId: "lect-fake",
        entryDate: "2026-07-22",
      })
    ).rejects.toThrow("LECTURER_NOT_FOUND");
    expect(prisma.dailyLogEntry.create).not.toHaveBeenCalled();
  });

  it("a NOTE/PROBLEM entry can optionally reference a student", async () => {
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.student.findFirst).mockResolvedValue(student as never);

    await createDailyLogEntry({
      departmentId: "dept-cs",
      type: "PROBLEM",
      title: "Repeated absences",
      relatedStudentId: "student-1",
      entryDate: "2026-07-22",
    });

    expect(prisma.dailyLogEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ relatedStudentId: "student-1" }),
    });
  });

  it("leaving the student picker blank is fine — relatedStudentId stays null", async () => {
    mockRoles(["ADMIN"]);

    await createDailyLogEntry({
      departmentId: "dept-cs",
      type: "NOTE",
      title: "General reminder",
      entryDate: "2026-07-22",
    });

    expect(prisma.student.findFirst).not.toHaveBeenCalled();
    expect(prisma.dailyLogEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ relatedStudentId: null }),
    });
  });

  it("a DEAN's related-student lookup IS scoped via studentDeanWhere — unlike the lecturer picker", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);
    vi.mocked(prisma.student.findFirst).mockResolvedValue(student as never);

    await createDailyLogEntry({
      departmentId: "dept-cs",
      type: "NOTE",
      title: "General reminder",
      relatedStudentId: "student-1",
      entryDate: "2026-07-22",
    });

    expect(prisma.student.findFirst).toHaveBeenCalledWith({
      where: {
        id: "student-1",
        class: { program: { departmentId: { in: ["dept-cs"] } } },
      },
    });
  });

  it("rejects a NOTE/PROBLEM student reference outside a DEAN's faculty", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);
    vi.mocked(prisma.student.findFirst).mockResolvedValue(null);

    await expect(
      createDailyLogEntry({
        departmentId: "dept-cs",
        type: "NOTE",
        title: "General reminder",
        relatedStudentId: "student-outside",
        entryDate: "2026-07-22",
      })
    ).rejects.toThrow("STUDENT_NOT_FOUND");
    expect(prisma.dailyLogEntry.create).not.toHaveBeenCalled();
  });

  it("rejects submitting both a lecturer and a student at once — the Zod schema enforces at most one, for every type", async () => {
    mockRoles(["ADMIN"]);

    await expect(
      createDailyLogEntry({
        departmentId: "dept-cs",
        type: "LEAVE_NOTICE",
        relatedLecturerId: "lect-1",
        relatedStudentId: "student-1",
        entryDate: "2026-07-22",
      })
    ).rejects.toThrow();
    expect(prisma.dailyLogEntry.create).not.toHaveBeenCalled();
  });

  it("rejects a LEAVE_NOTICE with neither a lecturer nor a student picked", async () => {
    mockRoles(["ADMIN"]);

    await expect(
      createDailyLogEntry({
        departmentId: "dept-cs",
        type: "LEAVE_NOTICE",
        entryDate: "2026-07-22",
      })
    ).rejects.toThrow();
    expect(prisma.dailyLogEntry.create).not.toHaveBeenCalled();
  });

  it("audits DAILYLOG_CREATED with department/type/lecturer context", async () => {
    mockRoles(["ADMIN"]);

    await createDailyLogEntry({
      departmentId: "dept-cs",
      type: "NOTE",
      title: "Broken projector",
      entryDate: "2026-07-22",
    });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        action: "DAILYLOG_CREATED",
        entity: "DailyLogEntry",
        entityId: "entry-1",
        newValue: expect.objectContaining({
          departmentId: "dept-cs",
          type: "NOTE",
        }),
      })
    );
  });
});

describe("createDailyLogEntry — leave-notice session linking + hours snapshot", () => {
  const slots = [
    {
      id: "slot-1",
      startTime: "09:00",
      endTime: "10:30",
      assignment: { course: { name: "Physics" }, class: { name: "CS-1" } },
    },
    {
      id: "slot-2",
      startTime: "11:00",
      endTime: "13:30",
      assignment: { course: { name: "Chemistry" }, class: { name: "CS-1" } },
    },
  ];

  let txEntryCreate: ReturnType<typeof vi.fn>;
  let txSessionCreateMany: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    vi.mocked(getUserAccess).mockResolvedValue({
      permissions: new Set(),
      roleNames: ["ADMIN"],
    } as never);
    vi.mocked(prisma.lecturer.findFirst).mockResolvedValue(lecturer as never);
    vi.mocked(fetchLeaveSessionSlots).mockResolvedValue(slots as never);

    // Plain (no-session) path — used by the note-only / NOTE cases below.
    vi.mocked(prisma.dailyLogEntry.create).mockResolvedValue({
      id: "entry-9",
      departmentId: "dept-cs",
      type: "LEAVE_NOTICE",
      relatedLecturerId: "lect-1",
      relatedStudentId: null,
      title: "Leave notice — Dr. Ahmed",
    } as never);

    txEntryCreate = vi.fn().mockResolvedValue({
      id: "entry-9",
      departmentId: "dept-cs",
      type: "LEAVE_NOTICE",
      relatedLecturerId: "lect-1",
      relatedStudentId: null,
      title: "Leave notice — Dr. Ahmed",
    });
    txSessionCreateMany = vi.fn();
    vi.mocked(prisma.$transaction).mockImplementation(
      ((fn: (tx: unknown) => unknown) =>
        Promise.resolve(
          fn({
            dailyLogEntry: { create: txEntryCreate },
            dailyLogEntrySession: { createMany: txSessionCreateMany },
          })
        )) as never
    );
  });

  it("re-resolves the selected slots server-side, snapshots each session, and stores the summed hours", async () => {
    await createDailyLogEntry({
      departmentId: "dept-cs",
      type: "LEAVE_NOTICE",
      relatedLecturerId: "lect-1",
      entryDate: "2026-08-31",
      sessionIds: ["slot-1", "slot-2"],
    });

    expect(fetchLeaveSessionSlots).toHaveBeenCalledWith({
      relatedLecturerId: "lect-1",
      relatedStudentId: null,
      entryDate: "2026-08-31",
    });

    expect(txEntryCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "LEAVE_NOTICE",
        relatedLecturerId: "lect-1",
        leaveHours: 4, // 1.5h + 2.5h
      }),
    });

    expect(txSessionCreateMany).toHaveBeenCalledWith({
      data: [
        {
          dailyLogEntryId: "entry-9",
          timetableSlotId: "slot-1",
          courseName: "Physics",
          className: "CS-1",
          startTime: "09:00",
          endTime: "10:30",
          hours: 1.5,
        },
        {
          dailyLogEntryId: "entry-9",
          timetableSlotId: "slot-2",
          courseName: "Chemistry",
          className: "CS-1",
          startTime: "11:00",
          endTime: "13:30",
          hours: 2.5,
        },
      ],
    });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        newValue: expect.objectContaining({ leaveHours: 4, sessionCount: 2 }),
      })
    );
  });

  it("drops a submitted slot id that isn't among the person's real sessions for that day", async () => {
    await createDailyLogEntry({
      departmentId: "dept-cs",
      type: "LEAVE_NOTICE",
      relatedLecturerId: "lect-1",
      entryDate: "2026-08-31",
      sessionIds: ["slot-1", "slot-BOGUS"],
    });

    expect(txEntryCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ leaveHours: 1.5 }),
    });
  });

  it("falls back to a plain note-only create (no transaction, leaveHours null) when no sessions are selected", async () => {
    await createDailyLogEntry({
      departmentId: "dept-cs",
      type: "LEAVE_NOTICE",
      relatedLecturerId: "lect-1",
      entryDate: "2026-08-31",
      sessionIds: [],
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(fetchLeaveSessionSlots).not.toHaveBeenCalled();
    expect(prisma.dailyLogEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "LEAVE_NOTICE", leaveHours: null }),
    });
  });

  it("ignores sessionIds entirely for a NOTE entry", async () => {
    await createDailyLogEntry({
      departmentId: "dept-cs",
      type: "NOTE",
      title: "x",
      relatedLecturerId: "lect-1",
      entryDate: "2026-08-31",
      sessionIds: ["slot-1"],
    });

    expect(fetchLeaveSessionSlots).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.dailyLogEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "NOTE", leaveHours: null }),
    });
  });
});
