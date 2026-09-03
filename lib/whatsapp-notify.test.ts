import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    whatsAppSettings: { findUnique: vi.fn() },
    whatsAppNotificationLog: { create: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
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
  sendTimetableNotifications,
  getRecentTimetableSend,
  sendManualNotification,
  buildWaMeUrl,
  buildWaMeShareUrl,
  buildLecturerCredentialsShareUrl,
  buildTimetableReadyShareUrl,
  buildClassTimetableGroupShareUrl,
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

describe("sendTimetableNotifications", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    invalidateWhatsAppTemplateCache();
    vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({
      id: "singleton",
      enabled: true,
    } as never);
    vi.mocked(prisma.whatsAppMessageTemplate.findMany).mockResolvedValue([]);
  });

  it("enqueues one TIMETABLE_CHANGE row per recipient (students and lecturers), skipping those with no phone", async () => {
    const result = await sendTimetableNotifications({
      changeSummary: "the class timetable has been updated.",
      recipients: [
        { type: "STUDENT", id: "s1", name: "Amina", phoneNumber: "+252611111111", className: "CMS26-A-FT", classId: "class-1" },
        { type: "STUDENT", id: "s2", name: "Bashir", phoneNumber: null, className: "CMS26-A-FT", classId: "class-1" },
        { type: "LECTURER", id: "l1", name: "Dr. Ahmed", phoneNumber: "+252633333333", className: "CMS26-A-FT", classId: "class-1" },
      ],
    });

    expect(result).toEqual({ enqueuedStudents: 1, enqueuedLecturers: 1, skipped: 1 });
    expect(prisma.whatsAppNotificationLog.create).toHaveBeenCalledTimes(2);
    expect(prisma.whatsAppNotificationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        recipientType: "STUDENT",
        recipientId: "s1",
        eventKey: "TIMETABLE_CHANGE",
        entity: "Class",
        entityId: "class-1",
        message: expect.stringContaining("the class timetable has been updated."),
      }),
    });
    expect(prisma.whatsAppNotificationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        recipientType: "LECTURER",
        recipientId: "l1",
        eventKey: "TIMETABLE_CHANGE",
      }),
    });
  });

  it("fills the recipient's own name into both {studentName} and {recipientName}", async () => {
    vi.mocked(prisma.whatsAppMessageTemplate.findMany).mockResolvedValue([
      { eventKey: "TIMETABLE_CHANGE", triggerKind: "AUTOMATIC", templateText: "{recipientName} ({className}): {changeSummary}" },
    ] as never);

    await sendTimetableNotifications({
      changeSummary: "updated.",
      recipients: [
        { type: "LECTURER", id: "l1", name: "Dr. Ahmed", phoneNumber: "+252633333333", className: "CMS26-A-FT, CMS26-B-FT", classId: "class-1" },
      ],
    });

    expect(prisma.whatsAppNotificationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        message: "Dr. Ahmed (CMS26-A-FT, CMS26-B-FT): updated.",
      }),
    });
  });

  it("enqueues nothing and never throws when the feature is disabled", async () => {
    vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({ id: "singleton", enabled: false } as never);

    const result = await sendTimetableNotifications({
      changeSummary: "updated.",
      recipients: [
        { type: "STUDENT", id: "s1", name: "Amina", phoneNumber: "+252611111111", className: "CMS26-A-FT", classId: "class-1" },
      ],
    });

    expect(result).toEqual({ enqueuedStudents: 0, enqueuedLecturers: 0, skipped: 1 });
    expect(prisma.whatsAppNotificationLog.create).not.toHaveBeenCalled();
  });
});

describe("getRecentTimetableSend", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns the latest TIMETABLE_CHANGE createdAt and the still-pending count for the given classes", async () => {
    const when = new Date("2026-09-02T10:00:00.000Z");
    vi.mocked(prisma.whatsAppNotificationLog.findFirst).mockResolvedValue({ createdAt: when } as never);
    vi.mocked(prisma.whatsAppNotificationLog.count).mockResolvedValue(7 as never);

    const info = await getRecentTimetableSend(["class-1", "class-2"]);

    expect(info).toEqual({ lastQueuedAt: when.toISOString(), stillPending: 7 });
    expect(prisma.whatsAppNotificationLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          eventKey: "TIMETABLE_CHANGE",
          entity: "Class",
          entityId: { in: ["class-1", "class-2"] },
        }),
      })
    );
  });

  it("short-circuits to an empty result for an empty class list", async () => {
    const info = await getRecentTimetableSend([]);
    expect(info).toEqual({ lastQueuedAt: null, stillPending: 0 });
    expect(prisma.whatsAppNotificationLog.findFirst).not.toHaveBeenCalled();
  });

  it("never throws — a DB failure just yields an empty result", async () => {
    vi.mocked(prisma.whatsAppNotificationLog.findFirst).mockRejectedValue(new Error("DB down"));
    await expect(getRecentTimetableSend(["class-1"])).resolves.toEqual({
      lastQueuedAt: null,
      stillPending: 0,
    });
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

describe("buildWaMeUrl", () => {
  it("strips non-digits from the number and URL-encodes the message", () => {
    expect(buildWaMeUrl("+252 61 111 1111", "Hi there & welcome")).toBe(
      "https://wa.me/252611111111?text=Hi%20there%20%26%20welcome"
    );
  });

  it("returns null when there is no phone number to link to", () => {
    expect(buildWaMeUrl(null, "x")).toBeNull();
    expect(buildWaMeUrl("+++", "x")).toBeNull();
  });
});

describe("buildLecturerCredentialsShareUrl", () => {
  const params = {
    phoneNumber: "+252611111111",
    username: "+252611111111",
    tempPassword: "TmpPass123",
    facultyName: "Faculty of Computing",
    academicYear: "2026-2027",
    semesterName: "Semester 1",
    domainName: "sams.university.edu",
  };

  beforeEach(() => {
    vi.resetAllMocks();
    invalidateWhatsAppTemplateCache();
    // No DB override -> the seeded LECTURER_LOGIN_CREDENTIALS default is used.
    vi.mocked(prisma.whatsAppMessageTemplate.findMany).mockResolvedValue([]);
  });

  it("returns a wa.me URL with the filled credential message — and NEVER enqueues a worker row", async () => {
    const { url } = await buildLecturerCredentialsShareUrl(params);

    expect(url).toMatch(/^https:\/\/wa\.me\/252611111111\?text=/);
    const message = decodeURIComponent(url!.split("?text=")[1]);
    expect(message).toContain("Username: +252611111111");
    expect(message).toContain("Password: TmpPass123");
    expect(message).toContain("Domain: sams.university.edu");
    expect(message).toContain("2026-2027, Semester 1");
    expect(message).toContain("Kulliyada: Faculty of Computing");
    expect(message).not.toMatch(/\{[a-zA-Z]+\}/); // no leftover tokens
    // The Baileys worker queue is untouched for this event type.
    expect(prisma.whatsAppNotificationLog.create).not.toHaveBeenCalled();
  });

  it("returns url:null when the lecturer has no phone number", async () => {
    const { url } = await buildLecturerCredentialsShareUrl({ ...params, phoneNumber: null });
    expect(url).toBeNull();
  });

  it("is NOT gated by the WhatsApp on/off toggle — a manual link doesn't use the worker", async () => {
    vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({ id: "singleton", enabled: false } as never);
    const { url } = await buildLecturerCredentialsShareUrl(params);
    expect(url).toMatch(/^https:\/\/wa\.me\//);
  });
});

describe("buildTimetableReadyShareUrl", () => {
  const params = {
    phoneNumber: "+252611111111",
    semesterName: "Semester 1",
    academicYear: "2026-2027",
    domainName: "sams.university.edu",
    facultyName: "Faculty of Computing",
  };

  beforeEach(() => {
    vi.resetAllMocks();
    invalidateWhatsAppTemplateCache();
    vi.mocked(prisma.whatsAppMessageTemplate.findMany).mockResolvedValue([]);
  });

  it("returns a wa.me URL with the filled TIMETABLE_READY message — NO username/password, NO worker row", async () => {
    const { url } = await buildTimetableReadyShareUrl(params);

    expect(url).toMatch(/^https:\/\/wa\.me\/252611111111\?text=/);
    const message = decodeURIComponent(url!.split("?text=")[1]);
    expect(message).toContain("Semester 1 2026-2027");
    expect(message).toContain("sams.university.edu");
    expect(message).toContain("Kulliyada: Faculty of Computing");
    expect(message).not.toMatch(/username|password/i);
    expect(message).not.toMatch(/\{[a-zA-Z]+\}/);
    expect(prisma.whatsAppNotificationLog.create).not.toHaveBeenCalled();
  });

  it("returns url:null when the lecturer has no phone number", async () => {
    const { url } = await buildTimetableReadyShareUrl({ ...params, phoneNumber: null });
    expect(url).toBeNull();
  });
});

describe("buildWaMeShareUrl", () => {
  it("builds a wa.me link with NO phone number (opens WhatsApp's chat/group picker)", () => {
    expect(buildWaMeShareUrl("Hi & bye")).toBe("https://wa.me/?text=Hi%20%26%20bye");
  });
});

describe("buildClassTimetableGroupShareUrl", () => {
  const params = {
    className: "CMS26-A-FT (Semester 3)",
    semesterName: "Semester 1",
    academicYear: "2026-2027",
    domainName: "sams.university.edu",
  };

  beforeEach(() => {
    vi.resetAllMocks();
    invalidateWhatsAppTemplateCache();
    vi.mocked(prisma.whatsAppMessageTemplate.findMany).mockResolvedValue([]);
  });

  it("returns a phone-number-less wa.me link with the filled message — NO worker row, NO phone", async () => {
    const { url } = await buildClassTimetableGroupShareUrl(params);

    expect(url).toMatch(/^https:\/\/wa\.me\/\?text=/); // NO number segment
    const message = decodeURIComponent(url.split("?text=")[1]);
    expect(message).toContain("Salaan Ardayda CMS26-A-FT (Semester 3)");
    expect(message).toContain("Semester 1 2026-2027");
    expect(message).toContain("sams.university.edu");
    expect(message).not.toMatch(/\{[a-zA-Z]+\}/); // no leftover tokens
    expect(prisma.whatsAppNotificationLog.create).not.toHaveBeenCalled();
  });
});
