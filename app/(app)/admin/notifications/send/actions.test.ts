import { describe, it, expect, vi, beforeEach } from "vitest";

const mockUser = { id: "user-1", fullName: "Admin Zahra" };

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

vi.mock("@/lib/whatsapp-notify", () => ({
  sendManualNotification: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    whatsAppMessageTemplate: { findFirst: vi.fn() },
    lecturer: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    department: { findUnique: vi.fn(), findMany: vi.fn() },
    class: { findFirst: vi.fn(), findMany: vi.fn() },
    student: { findFirst: vi.fn(), findMany: vi.fn() },
    studentCourseEnrollment: { findMany: vi.fn() },
    lecturerCourseAssignment: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));

// Keep the real pure where-builders (classDeanWhere/studentDeanWhere/
// lecturerDeanWhere) — only getDeanDepartmentIds touches the DB, so only
// that needs mocking. This is what lets these tests assert against the
// SAME shape resolveManualRecipients actually sends to Prisma.
vi.mock("@/lib/dean-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dean-scope")>();
  return { ...actual, getDeanDepartmentIds: vi.fn() };
});

import { requirePermission, getUserAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { getDeanDepartmentIds } from "@/lib/dean-scope";
import { sendManualNotification as enqueueManualNotification } from "@/lib/whatsapp-notify";
import { previewManualNotificationRecipients, sendManualNotification } from "./actions";

function mockRoles(roleNames: string[]) {
  vi.mocked(getUserAccess).mockResolvedValue({ permissions: new Set(), roleNames } as never);
}

const manualTemplate = {
  id: "tpl-1",
  eventKey: "UNIVERSITY_HOLIDAY",
  name: "University Holiday",
  triggerKind: "MANUAL",
  deletedAt: null,
  templateText: "Hi {recipientName}: {message}",
};

describe("previewManualNotificationRecipients / sendManualNotification — permission gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("previewManualNotificationRecipients requires notification.send.manual", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(
      previewManualNotificationRecipients({
        recipientKind: "STUDENT",
        target: "INDIVIDUAL",
        targetId: "s1",
      })
    ).rejects.toThrow("FORBIDDEN");
  });

  it("sendManualNotification requires notification.send.manual", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(
      sendManualNotification({
        templateId: "tpl-1",
        recipientKind: "STUDENT",
        target: "INDIVIDUAL",
        targetId: "s1",
        message: "",
      })
    ).rejects.toThrow("FORBIDDEN");
    expect(prisma.whatsAppMessageTemplate.findFirst).not.toHaveBeenCalled();
  });
});

describe("sendManualNotification — ADMIN tier (unscoped)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    mockRoles(["ADMIN"]);
    vi.mocked(prisma.whatsAppMessageTemplate.findFirst).mockResolvedValue(manualTemplate as never);
    vi.mocked(enqueueManualNotification).mockResolvedValue({
      enqueued: 1,
      skippedNoPhoneOrDisabled: 0,
    } as never);
  });

  it("throws NOT_FOUND for a missing/deactivated/non-manual template", async () => {
    vi.mocked(prisma.whatsAppMessageTemplate.findFirst).mockResolvedValue(null);

    await expect(
      sendManualNotification({
        templateId: "missing",
        recipientKind: "STUDENT",
        target: "INDIVIDUAL",
        targetId: "s1",
        message: "",
      })
    ).rejects.toThrow("NOT_FOUND");
    expect(prisma.whatsAppMessageTemplate.findFirst).toHaveBeenCalledWith({
      where: { id: "missing", triggerKind: "MANUAL", deletedAt: null },
    });
  });

  it("refuses to send a template with an unknown placeholder (defense in depth)", async () => {
    vi.mocked(prisma.whatsAppMessageTemplate.findFirst).mockResolvedValue({
      ...manualTemplate,
      templateText: "{assessmentTitle}",
    } as never);

    await expect(
      sendManualNotification({
        templateId: "tpl-1",
        recipientKind: "STUDENT",
        target: "INDIVIDUAL",
        targetId: "s1",
        message: "",
      })
    ).rejects.toThrow("INVALID_TEMPLATE");
    expect(enqueueManualNotification).not.toHaveBeenCalled();
  });

  it("sends to any individual student, unscoped", async () => {
    vi.mocked(prisma.student.findFirst).mockResolvedValue({
      id: "s1",
      fullName: "Amina",
      phoneNumber: "+252611111111",
      class: { name: "CMS26-A-FT" },
    } as never);

    const result = await sendManualNotification({
      templateId: "tpl-1",
      recipientKind: "STUDENT",
      target: "INDIVIDUAL",
      targetId: "s1",
      message: "No classes Thursday.",
    });

    expect(prisma.student.findFirst).toHaveBeenCalledWith({
      where: { id: "s1" },
      select: expect.any(Object),
    });
    expect(enqueueManualNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: "tpl-1",
        eventKey: "UNIVERSITY_HOLIDAY",
        senderName: "Admin Zahra",
        message: "No classes Thursday.",
        recipients: [
          expect.objectContaining({ type: "STUDENT", id: "s1", className: "CMS26-A-FT" }),
        ],
      })
    );
    expect(result).toEqual({ recipientCount: 1, enqueued: 1, skippedNoPhoneOrDisabled: 0 });
  });

  it("audits WHATSAPP_MANUAL_SENT with a summary, not one row per recipient", async () => {
    vi.mocked(prisma.student.findFirst).mockResolvedValue({
      id: "s1",
      fullName: "Amina",
      phoneNumber: "+252611111111",
      class: { name: "CMS26-A-FT" },
    } as never);

    await sendManualNotification({
      templateId: "tpl-1",
      recipientKind: "STUDENT",
      target: "INDIVIDUAL",
      targetId: "s1",
      message: "",
    });

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        action: "WHATSAPP_MANUAL_SENT",
        entity: "WhatsAppMessageTemplate",
        entityId: "tpl-1",
        newValue: expect.objectContaining({ recipientCount: 1, enqueued: 1 }),
      })
    );
  });

  it("sends to a whole class (every current student), unscoped", async () => {
    vi.mocked(prisma.class.findFirst).mockResolvedValue({ id: "class-1", name: "CMS26-A-FT" } as never);
    vi.mocked(prisma.student.findMany).mockResolvedValue([
      { id: "s1", fullName: "Amina", phoneNumber: "+252611111111" },
      { id: "s2", fullName: "Bashir", phoneNumber: null },
    ] as never);

    const result = await sendManualNotification({
      templateId: "tpl-1",
      recipientKind: "STUDENT",
      target: "CLASS",
      targetId: "class-1",
      message: "hi",
    });

    expect(prisma.class.findFirst).toHaveBeenCalledWith({ where: { id: "class-1" }, select: expect.any(Object) });
    expect(result.recipientCount).toBe(2);
  });

  it("sends to a whole faculty's lecturers via Lecturer.departmentId, unscoped", async () => {
    vi.mocked(prisma.department.findUnique).mockResolvedValue({ name: "Faculty of Computing" } as never);
    vi.mocked(prisma.lecturer.findMany).mockResolvedValue([
      { id: "l1", fullName: "Dr. Ahmed", phoneNumber: "+252633333333" },
    ] as never);

    await sendManualNotification({
      templateId: "tpl-1",
      recipientKind: "LECTURER",
      target: "FACULTY",
      targetId: "dept-1",
      message: "",
    });

    expect(prisma.lecturer.findMany).toHaveBeenCalledWith({
      where: { departmentId: "dept-1" },
      select: expect.any(Object),
    });
    expect(enqueueManualNotification).toHaveBeenCalledWith(
      expect.objectContaining({ facultyName: "Faculty of Computing" })
    );
  });
});

describe("sendManualNotification — DEAN tier (faculty-scoped)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    mockRoles(["DEAN"]);
    vi.mocked(getDeanDepartmentIds).mockResolvedValue(["dept-mine"]);
    vi.mocked(prisma.whatsAppMessageTemplate.findFirst).mockResolvedValue(manualTemplate as never);
    vi.mocked(enqueueManualNotification).mockResolvedValue({
      enqueued: 1,
      skippedNoPhoneOrDisabled: 0,
    } as never);
  });

  it("scopes the class lookup through classDeanWhere — an out-of-scope class is NOT_FOUND", async () => {
    vi.mocked(prisma.class.findFirst).mockResolvedValue(null);

    await expect(
      sendManualNotification({
        templateId: "tpl-1",
        recipientKind: "STUDENT",
        target: "CLASS",
        targetId: "class-other-faculty",
        message: "",
      })
    ).rejects.toThrow("NOT_FOUND");

    expect(prisma.class.findFirst).toHaveBeenCalledWith({
      where: {
        id: "class-other-faculty",
        program: { departmentId: { in: ["dept-mine"] } },
      },
      select: expect.any(Object),
    });
  });

  it("rejects a FACULTY target outside the dean's own departments", async () => {
    await expect(
      sendManualNotification({
        templateId: "tpl-1",
        recipientKind: "STUDENT",
        target: "FACULTY",
        targetId: "dept-not-mine",
        message: "",
      })
    ).rejects.toThrow("FORBIDDEN");
    expect(enqueueManualNotification).not.toHaveBeenCalled();
  });

  it("allows a FACULTY target that IS one of the dean's own departments", async () => {
    vi.mocked(prisma.department.findUnique).mockResolvedValue({ name: "Faculty of Computing" } as never);
    vi.mocked(prisma.student.findMany).mockResolvedValue([
      { id: "s1", fullName: "Amina", phoneNumber: "+252611111111", class: { name: "CMS26-A-FT" } },
    ] as never);

    const result = await sendManualNotification({
      templateId: "tpl-1",
      recipientKind: "STUDENT",
      target: "FACULTY",
      targetId: "dept-mine",
      message: "",
    });

    expect(result.recipientCount).toBe(1);
  });
});

describe("sendManualNotification — LECTURER tier (own-assignment-scoped)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    mockRoles(["LECTURER"]);
    vi.mocked(prisma.lecturer.findUnique).mockResolvedValue({ id: "lect-1" } as never);
    vi.mocked(prisma.whatsAppMessageTemplate.findFirst).mockResolvedValue(manualTemplate as never);
    vi.mocked(enqueueManualNotification).mockResolvedValue({
      enqueued: 1,
      skippedNoPhoneOrDisabled: 0,
    } as never);
  });

  it("never allows recipientKind LECTURER — a lecturer can only message students", async () => {
    await expect(
      sendManualNotification({
        templateId: "tpl-1",
        recipientKind: "LECTURER",
        target: "INDIVIDUAL",
        targetId: "some-lecturer",
        message: "",
      })
    ).rejects.toThrow("FORBIDDEN");
    expect(enqueueManualNotification).not.toHaveBeenCalled();
  });

  it("never allows FACULTY scope", async () => {
    await expect(
      sendManualNotification({
        templateId: "tpl-1",
        recipientKind: "STUDENT",
        target: "FACULTY",
        targetId: "dept-1",
        message: "",
      })
    ).rejects.toThrow("FORBIDDEN");
  });

  it("scopes CLASS target to the lecturer's OWN LecturerCourseAssignment (never another lecturer's)", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue(null);

    await expect(
      sendManualNotification({
        templateId: "tpl-1",
        recipientKind: "STUDENT",
        target: "CLASS",
        targetId: "assignment-not-mine",
        message: "",
      })
    ).rejects.toThrow("NOT_FOUND");

    expect(prisma.lecturerCourseAssignment.findFirst).toHaveBeenCalledWith({
      where: { id: "assignment-not-mine", lecturerId: "lect-1" },
      select: expect.any(Object),
    });
  });

  it("resolves CLASS target to exactly the students ACTIVE-enrolled in that assignment's own course+class+semester", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findFirst).mockResolvedValue({
      courseId: "course-1",
      classId: "class-1",
      semesterId: "sem-1",
    } as never);
    vi.mocked(prisma.studentCourseEnrollment.findMany).mockResolvedValue([
      {
        student: { id: "s1", fullName: "Amina", phoneNumber: "+252611111111", class: { name: "CMS26-A-FT" } },
      },
    ] as never);

    const result = await sendManualNotification({
      templateId: "tpl-1",
      recipientKind: "STUDENT",
      target: "CLASS",
      targetId: "assignment-1",
      message: "Submit by Friday.",
    });

    expect(prisma.studentCourseEnrollment.findMany).toHaveBeenCalledWith({
      where: { status: "ACTIVE", courseId: "course-1", classId: "class-1", semesterId: "sem-1" },
      select: expect.any(Object),
    });
    expect(result.recipientCount).toBe(1);
  });

  it("scopes an INDIVIDUAL student pick to students enrolled in one of the lecturer's own assignments", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([
      { courseId: "course-1", classId: "class-1", semesterId: "sem-1" },
    ] as never);
    vi.mocked(prisma.student.findFirst).mockResolvedValue(null);

    await expect(
      sendManualNotification({
        templateId: "tpl-1",
        recipientKind: "STUDENT",
        target: "INDIVIDUAL",
        targetId: "not-my-student",
        message: "",
      })
    ).rejects.toThrow("NOT_FOUND");

    expect(prisma.student.findFirst).toHaveBeenCalledWith({
      where: {
        id: "not-my-student",
        enrollments: {
          some: {
            status: "ACTIVE",
            OR: [{ courseId: "course-1", classId: "class-1", semesterId: "sem-1" }],
          },
        },
      },
      select: expect.any(Object),
    });
  });

  it("a lecturer with zero assignments resolves NOT_FOUND rather than matching every student", async () => {
    vi.mocked(prisma.lecturerCourseAssignment.findMany).mockResolvedValue([] as never);

    await expect(
      sendManualNotification({
        templateId: "tpl-1",
        recipientKind: "STUDENT",
        target: "INDIVIDUAL",
        targetId: "any-student",
        message: "",
      })
    ).rejects.toThrow("NOT_FOUND");
    expect(prisma.student.findFirst).not.toHaveBeenCalled();
  });
});

describe("previewManualNotificationRecipients", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockUser as never);
    mockRoles(["ADMIN"]);
  });

  it("reports count/sample/skippedNoPhone without enqueueing anything", async () => {
    vi.mocked(prisma.class.findFirst).mockResolvedValue({ id: "class-1", name: "CMS26-A-FT" } as never);
    vi.mocked(prisma.student.findMany).mockResolvedValue([
      { id: "s1", fullName: "Amina", phoneNumber: "+252611111111" },
      { id: "s2", fullName: "Bashir", phoneNumber: null },
    ] as never);

    const preview = await previewManualNotificationRecipients({
      recipientKind: "STUDENT",
      target: "CLASS",
      targetId: "class-1",
    });

    expect(preview).toEqual({
      count: 2,
      sample: [{ name: "Amina", className: "CMS26-A-FT" }],
      truncated: false,
      skippedNoPhone: 1,
    });
    expect(enqueueManualNotification).not.toHaveBeenCalled();
  });
});
