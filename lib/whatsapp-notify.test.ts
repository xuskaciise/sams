import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    whatsAppSettings: { findUnique: vi.fn() },
    whatsAppNotificationLog: { create: vi.fn() },
    whatsAppMessageTemplate: { findMany: vi.fn() },
    assessment: { findUnique: vi.fn() },
    assessmentResult: { findMany: vi.fn() },
    dailyLogEntry: { findUnique: vi.fn() },
    student: { findMany: vi.fn() },
    class: { findUnique: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import {
  notifyResultsPublished,
  notifyLeaveNotice,
  notifyTimetableChange,
  sendManualNotification,
  invalidateWhatsAppTemplateCache,
} from "./whatsapp-notify";

describe("notifyResultsPublished", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    invalidateWhatsAppTemplateCache();
    vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({
      id: "singleton",
      enabled: true,
    } as never);
    vi.mocked(prisma.assessment.findUnique).mockResolvedValue({
      title: "Quiz 1",
      assignment: {
        course: { name: "Databases" },
        class: { name: "CMS26-A-FT" },
        semester: { name: "Semester 1" },
      },
    } as never);
    vi.mocked(prisma.whatsAppMessageTemplate.findMany).mockResolvedValue([]);
  });

  it("enqueues one notification per published result with a phone number", async () => {
    vi.mocked(prisma.assessmentResult.findMany).mockResolvedValue([
      {
        mark: { toString: () => "18" },
        attendanceStatus: "PRESENT",
        enrollment: { student: { id: "s1", fullName: "Amina", phoneNumber: "+252611111111" } },
      },
      {
        mark: null,
        attendanceStatus: "ABSENT",
        enrollment: { student: { id: "s2", fullName: "Bashir", phoneNumber: null } },
      },
    ] as never);

    await notifyResultsPublished("assessment-1");

    expect(prisma.whatsAppNotificationLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.whatsAppNotificationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        recipientType: "STUDENT",
        recipientId: "s1",
        recipientName: "Amina",
        phoneNumber: "+252611111111",
        eventKey: "RESULTS_PUBLISHED",
        entity: "Assessment",
        entityId: "assessment-1",
        message: expect.stringContaining("Databases"),
      }),
    });
  });

  it("never throws when the feature is disabled — publishing must not be affected", async () => {
    vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({
      id: "singleton",
      enabled: false,
    } as never);
    vi.mocked(prisma.assessmentResult.findMany).mockResolvedValue([
      {
        mark: { toString: () => "18" },
        attendanceStatus: "PRESENT",
        enrollment: { student: { id: "s1", fullName: "Amina", phoneNumber: "+252611111111" } },
      },
    ] as never);

    await expect(notifyResultsPublished("assessment-1")).resolves.toBeUndefined();
    expect(prisma.whatsAppNotificationLog.create).not.toHaveBeenCalled();
  });

  it("never throws even when the DB lookup itself fails", async () => {
    vi.mocked(prisma.assessment.findUnique).mockRejectedValue(new Error("DB down"));

    await expect(notifyResultsPublished("assessment-1")).resolves.toBeUndefined();
  });

  it("uses a custom template from the DB when one is saved", async () => {
    vi.mocked(prisma.whatsAppMessageTemplate.findMany).mockResolvedValue([
      {
        eventKey: "RESULTS_PUBLISHED",
        triggerKind: "AUTOMATIC",
        templateText: "{studentName} scored {mark} in {courseName}",
      },
    ] as never);
    vi.mocked(prisma.assessmentResult.findMany).mockResolvedValue([
      {
        mark: { toString: () => "18" },
        attendanceStatus: "PRESENT",
        enrollment: { student: { id: "s1", fullName: "Amina", phoneNumber: "+252611111111" } },
      },
    ] as never);

    await notifyResultsPublished("assessment-1");

    expect(prisma.whatsAppNotificationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        message: "Amina scored 18 in Databases",
      }),
    });
  });

  it("falls back to the default template when the stored one has an unknown placeholder (corrupted/edited directly in the DB)", async () => {
    vi.mocked(prisma.whatsAppMessageTemplate.findMany).mockResolvedValue([
      {
        eventKey: "RESULTS_PUBLISHED",
        triggerKind: "AUTOMATIC",
        templateText: "Hello {studnetName}, results are in",
      },
    ] as never);
    vi.mocked(prisma.assessmentResult.findMany).mockResolvedValue([
      {
        mark: { toString: () => "18" },
        attendanceStatus: "PRESENT",
        enrollment: { student: { id: "s1", fullName: "Amina", phoneNumber: "+252611111111" } },
      },
    ] as never);

    await notifyResultsPublished("assessment-1");

    expect(prisma.whatsAppNotificationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        message: expect.stringContaining("Hello Amina, your results for Databases"),
      }),
    });
  });

  it("falls back to the default template when the stored one is blank", async () => {
    vi.mocked(prisma.whatsAppMessageTemplate.findMany).mockResolvedValue([
      { eventKey: "RESULTS_PUBLISHED", triggerKind: "AUTOMATIC", templateText: "   " },
    ] as never);
    vi.mocked(prisma.assessmentResult.findMany).mockResolvedValue([
      {
        mark: { toString: () => "18" },
        attendanceStatus: "PRESENT",
        enrollment: { student: { id: "s1", fullName: "Amina", phoneNumber: "+252611111111" } },
      },
    ] as never);

    await notifyResultsPublished("assessment-1");

    expect(prisma.whatsAppNotificationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        message: expect.stringContaining("Hello Amina, your results for Databases"),
      }),
    });
  });
});

describe("notifyLeaveNotice", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    invalidateWhatsAppTemplateCache();
    vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({
      id: "singleton",
      enabled: true,
    } as never);
    vi.mocked(prisma.whatsAppMessageTemplate.findMany).mockResolvedValue([]);
  });

  it("notifies the named lecturer when relatedLecturer is set", async () => {
    vi.mocked(prisma.dailyLogEntry.findUnique).mockResolvedValue({
      title: "Leave notice — Dr. Ahmed",
      description: "Out sick",
      entryDate: new Date("2026-07-29"),
      relatedLecturer: {
        id: "lect-1",
        phoneNumber: "+252611111111",
        fullName: "Dr. Ahmed",
      },
      relatedStudent: null,
    } as never);

    await notifyLeaveNotice("entry-1");

    expect(prisma.whatsAppNotificationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        recipientType: "LECTURER",
        recipientId: "lect-1",
        eventKey: "LEAVE_NOTICE",
        entity: "DailyLogEntry",
        entityId: "entry-1",
      }),
    });
  });

  it("notifies the named student when relatedStudent is set instead", async () => {
    vi.mocked(prisma.dailyLogEntry.findUnique).mockResolvedValue({
      title: "Leave notice — Amina",
      description: null,
      entryDate: new Date("2026-07-29"),
      relatedLecturer: null,
      relatedStudent: { id: "s1", phoneNumber: "+252611111111", fullName: "Amina" },
    } as never);

    await notifyLeaveNotice("entry-2");

    expect(prisma.whatsAppNotificationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        recipientType: "STUDENT",
        recipientId: "s1",
        eventKey: "LEAVE_NOTICE",
      }),
    });
  });

  it("enqueues nothing when neither is set and never throws", async () => {
    vi.mocked(prisma.dailyLogEntry.findUnique).mockResolvedValue({
      title: "Note",
      description: null,
      entryDate: new Date("2026-07-29"),
      relatedLecturer: null,
      relatedStudent: null,
    } as never);

    await expect(notifyLeaveNotice("entry-3")).resolves.toBeUndefined();
    expect(prisma.whatsAppNotificationLog.create).not.toHaveBeenCalled();
  });
});

describe("notifyTimetableChange", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    invalidateWhatsAppTemplateCache();
    vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({
      id: "singleton",
      enabled: true,
    } as never);
    vi.mocked(prisma.whatsAppMessageTemplate.findMany).mockResolvedValue([]);
    vi.mocked(prisma.class.findUnique).mockResolvedValue({ name: "CMS26-A-FT" } as never);
  });

  it("enqueues one notification per current student of the class, skipping those with no phone", async () => {
    vi.mocked(prisma.student.findMany).mockResolvedValue([
      { id: "s1", fullName: "Amina", phoneNumber: "+252611111111" },
      { id: "s2", fullName: "Bashir", phoneNumber: null },
    ] as never);

    await notifyTimetableChange("class-1", "a session was added.");

    expect(prisma.whatsAppNotificationLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.whatsAppNotificationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        recipientType: "STUDENT",
        recipientId: "s1",
        eventKey: "TIMETABLE_CHANGE",
        entity: "Class",
        entityId: "class-1",
        message: expect.stringContaining("a session was added."),
      }),
    });
  });

  it("never throws when the notification log insert itself fails", async () => {
    vi.mocked(prisma.student.findMany).mockResolvedValue([
      { id: "s1", fullName: "Amina", phoneNumber: "+252611111111" },
    ] as never);
    vi.mocked(prisma.whatsAppNotificationLog.create).mockRejectedValue(
      new Error("insert failed")
    );

    await expect(
      notifyTimetableChange("class-1", "a session was added.")
    ).resolves.toBeUndefined();
  });
});

describe("sendManualNotification", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    invalidateWhatsAppTemplateCache();
    vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({
      id: "singleton",
      enabled: true,
    } as never);
  });

  it("enqueues one message per recipient, filling recipientName/senderName/message per recipient", async () => {
    const result = await sendManualNotification({
      templateId: "tpl-1",
      eventKey: "UNIVERSITY_HOLIDAY",
      templateText: "Hi {recipientName}, from {senderName}: {message}",
      senderName: "Admin Zahra",
      message: "No classes on Thursday.",
      facultyName: "",
      recipients: [
        { type: "STUDENT", id: "s1", name: "Amina", phoneNumber: "+252611111111" },
        { type: "STUDENT", id: "s2", name: "Bashir", phoneNumber: "+252622222222" },
      ],
    });

    expect(result).toEqual({ enqueued: 2, skippedNoPhoneOrDisabled: 0 });
    expect(prisma.whatsAppNotificationLog.create).toHaveBeenCalledTimes(2);
    expect(prisma.whatsAppNotificationLog.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        recipientId: "s1",
        eventKey: "UNIVERSITY_HOLIDAY",
        entity: "WhatsAppMessageTemplate",
        entityId: "tpl-1",
        message: "Hi Amina, from Admin Zahra: No classes on Thursday.",
      }),
    });
    expect(prisma.whatsAppNotificationLog.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        recipientId: "s2",
        message: "Hi Bashir, from Admin Zahra: No classes on Thursday.",
      }),
    });
  });

  it("skips (never fails the batch for) a recipient with no phone number", async () => {
    const result = await sendManualNotification({
      templateId: "tpl-1",
      eventKey: "UNIVERSITY_HOLIDAY",
      templateText: "Hi {recipientName}",
      senderName: "Admin Zahra",
      message: "",
      facultyName: "",
      recipients: [
        { type: "STUDENT", id: "s1", name: "Amina", phoneNumber: "+252611111111" },
        { type: "STUDENT", id: "s2", name: "Bashir", phoneNumber: null },
      ],
    });

    expect(result).toEqual({ enqueued: 1, skippedNoPhoneOrDisabled: 1 });
    expect(prisma.whatsAppNotificationLog.create).toHaveBeenCalledTimes(1);
  });

  it("fills className only for the recipient it's set on, and facultyName from the scope", async () => {
    await sendManualNotification({
      templateId: "tpl-1",
      eventKey: "UNIVERSITY_HOLIDAY",
      templateText: "{recipientName} — {className} — {facultyName}",
      senderName: "Admin Zahra",
      message: "",
      facultyName: "Faculty of Computing",
      recipients: [
        {
          type: "STUDENT",
          id: "s1",
          name: "Amina",
          phoneNumber: "+252611111111",
          className: "CMS26-A-FT",
        },
        { type: "LECTURER", id: "l1", name: "Dr. Ahmed", phoneNumber: "+252633333333" },
      ],
    });

    expect(prisma.whatsAppNotificationLog.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        message: "Amina — CMS26-A-FT — Faculty of Computing",
      }),
    });
    expect(prisma.whatsAppNotificationLog.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        recipientType: "LECTURER",
        message: "Dr. Ahmed —  — Faculty of Computing",
      }),
    });
  });

  it("enqueues nothing when the feature is disabled, and never throws", async () => {
    vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({
      id: "singleton",
      enabled: false,
    } as never);

    const result = await sendManualNotification({
      templateId: "tpl-1",
      eventKey: "UNIVERSITY_HOLIDAY",
      templateText: "Hi {recipientName}",
      senderName: "Admin Zahra",
      message: "",
      facultyName: "",
      recipients: [{ type: "STUDENT", id: "s1", name: "Amina", phoneNumber: "+252611111111" }],
    });

    expect(result).toEqual({ enqueued: 0, skippedNoPhoneOrDisabled: 1 });
    expect(prisma.whatsAppNotificationLog.create).not.toHaveBeenCalled();
  });
});
