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
    dailyLogEntry: { create: vi.fn() },
  },
}));

vi.mock("@/lib/dean-scope", () => ({
  getDeanDepartmentIds: vi.fn(),
  lecturerDeanWhere: vi.fn((ids: string[]) => ({
    assignments: { some: { class: { program: { departmentId: { in: ids } } } } },
  })),
}));

import { requirePermission, getUserAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import { createDailyLogEntry } from "./actions";

const lecturer = {
  id: "lect-1",
  user: { fullName: "Dr. Ahmed" },
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
  });

  it("a DEAN's LEAVE_NOTICE lecturer lookup is scoped via lecturerDeanWhere", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);
    vi.mocked(prisma.lecturer.findFirst).mockResolvedValue(lecturer as never);

    await createDailyLogEntry({
      departmentId: "dept-cs",
      type: "LEAVE_NOTICE",
      relatedLecturerId: "lect-1",
      entryDate: "2026-07-22",
    });

    expect(prisma.lecturer.findFirst).toHaveBeenCalledWith({
      where: {
        id: "lect-1",
        assignments: { some: { class: { program: { departmentId: { in: ["dept-cs"] } } } } },
      },
      include: { user: true },
    });
  });

  it("rejects a LEAVE_NOTICE referencing a lecturer outside the dean's scope", async () => {
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-cs"]);
    vi.mocked(prisma.lecturer.findFirst).mockResolvedValue(null);

    await expect(
      createDailyLogEntry({
        departmentId: "dept-cs",
        type: "LEAVE_NOTICE",
        relatedLecturerId: "lect-outside",
        entryDate: "2026-07-22",
      })
    ).rejects.toThrow("LECTURER_NOT_FOUND");
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
