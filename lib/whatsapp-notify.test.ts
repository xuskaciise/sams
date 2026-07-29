import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    whatsAppSettings: { findUnique: vi.fn() },
    whatsAppNotificationLog: { create: vi.fn() },
    assessment: { findUnique: vi.fn() },
    assessmentResult: { findMany: vi.fn() },
    dailyLogEntry: { findUnique: vi.fn() },
    student: { findMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import {
  notifyResultsPublished,
  notifyLeaveNotice,
  notifyTimetableChange,
} from "./whatsapp-notify";

describe("notifyResultsPublished", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({
      id: "singleton",
      enabled: true,
    } as never);
    vi.mocked(prisma.assessment.findUnique).mockResolvedValue({
      title: "Quiz 1",
      assignment: { course: { name: "Databases" } },
    } as never);
  });

  it("enqueues one notification per published result with a phone number", async () => {
    vi.mocked(prisma.assessmentResult.findMany).mockResolvedValue([
      { enrollment: { student: { id: "s1", fullName: "Amina", phoneNumber: "+252611111111" } } },
      { enrollment: { student: { id: "s2", fullName: "Bashir", phoneNumber: null } } },
    ] as never);

    await notifyResultsPublished("assessment-1");

    expect(prisma.whatsAppNotificationLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.whatsAppNotificationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        recipientType: "STUDENT",
        recipientId: "s1",
        recipientName: "Amina",
        phoneNumber: "+252611111111",
        eventType: "RESULTS_PUBLISHED",
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
      { enrollment: { student: { id: "s1", fullName: "Amina", phoneNumber: "+252611111111" } } },
    ] as never);

    await expect(notifyResultsPublished("assessment-1")).resolves.toBeUndefined();
    expect(prisma.whatsAppNotificationLog.create).not.toHaveBeenCalled();
  });

  it("never throws even when the DB lookup itself fails", async () => {
    vi.mocked(prisma.assessment.findUnique).mockRejectedValue(new Error("DB down"));

    await expect(notifyResultsPublished("assessment-1")).resolves.toBeUndefined();
  });
});

describe("notifyLeaveNotice", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({
      id: "singleton",
      enabled: true,
    } as never);
  });

  it("notifies the named lecturer when relatedLecturer is set", async () => {
    vi.mocked(prisma.dailyLogEntry.findUnique).mockResolvedValue({
      title: "Leave notice — Dr. Ahmed",
      description: "Out sick",
      entryDate: new Date("2026-07-29"),
      relatedLecturer: {
        id: "lect-1",
        phoneNumber: "+252611111111",
        user: { fullName: "Dr. Ahmed" },
      },
      relatedStudent: null,
    } as never);

    await notifyLeaveNotice("entry-1");

    expect(prisma.whatsAppNotificationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        recipientType: "LECTURER",
        recipientId: "lect-1",
        eventType: "LEAVE_NOTICE",
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
        eventType: "LEAVE_NOTICE",
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
    vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({
      id: "singleton",
      enabled: true,
    } as never);
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
        eventType: "TIMETABLE_CHANGE",
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
