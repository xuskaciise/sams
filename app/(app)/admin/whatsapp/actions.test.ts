import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAdmin = { id: "admin-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    whatsAppSettings: { findUnique: vi.fn(), update: vi.fn() },
    whatsAppNotificationLog: { findUnique: vi.fn(), update: vi.fn() },
    whatsAppMessageTemplate: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { DEFAULT_WHATSAPP_TEMPLATES } from "@/lib/whatsapp-templates";
import {
  setWhatsAppEnabled,
  retryWhatsAppNotification,
  updateWhatsAppTemplate,
  resetWhatsAppTemplate,
} from "./actions";

describe("setWhatsAppEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({
      id: "singleton",
      enabled: false,
    } as never);
  });

  it("requires whatsapp.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(setWhatsAppEnabled(true)).rejects.toThrow("FORBIDDEN");
    expect(prisma.whatsAppSettings.update).not.toHaveBeenCalled();
  });

  it("flips the singleton row's enabled flag", async () => {
    await setWhatsAppEnabled(true);

    expect(prisma.whatsAppSettings.update).toHaveBeenCalledWith({
      where: { id: "singleton" },
      data: { enabled: true },
    });
  });

  it("audits WHATSAPP_TOGGLED with old and new values", async () => {
    await setWhatsAppEnabled(true);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "WHATSAPP_TOGGLED",
        entity: "WhatsAppSettings",
        oldValue: { enabled: false },
        newValue: { enabled: true },
      })
    );
  });
});

describe("retryWhatsAppNotification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
  });

  it("requires whatsapp.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(retryWhatsAppNotification("log-1")).rejects.toThrow("FORBIDDEN");
    expect(prisma.whatsAppNotificationLog.update).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND for a nonexistent log row", async () => {
    vi.mocked(prisma.whatsAppNotificationLog.findUnique).mockResolvedValue(null);

    await expect(retryWhatsAppNotification("missing")).rejects.toThrow("NOT_FOUND");
  });

  it("refuses to retry a row that isn't FAILED — only failed sends can be retried", async () => {
    vi.mocked(prisma.whatsAppNotificationLog.findUnique).mockResolvedValue({
      id: "log-1",
      status: "SENT",
    } as never);

    await expect(retryWhatsAppNotification("log-1")).rejects.toThrow("NOT_FAILED");
    expect(prisma.whatsAppNotificationLog.update).not.toHaveBeenCalled();
  });

  it("flips a FAILED row back to PENDING and clears lastError, for the worker's next poll", async () => {
    vi.mocked(prisma.whatsAppNotificationLog.findUnique).mockResolvedValue({
      id: "log-1",
      status: "FAILED",
    } as never);

    await retryWhatsAppNotification("log-1");

    expect(prisma.whatsAppNotificationLog.update).toHaveBeenCalledWith({
      where: { id: "log-1" },
      data: { status: "PENDING", lastError: null },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WHATSAPP_NOTIFICATION_RETRIED",
        entity: "WhatsAppNotificationLog",
        entityId: "log-1",
      })
    );
  });
});

describe("updateWhatsAppTemplate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.whatsAppMessageTemplate.findUnique).mockResolvedValue({
      eventType: "RESULTS_PUBLISHED",
      templateText: "old text",
    } as never);
  });

  it("requires notification.templates.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(
      updateWhatsAppTemplate("RESULTS_PUBLISHED", "Hello {studentName}")
    ).rejects.toThrow("FORBIDDEN");
    expect(prisma.whatsAppMessageTemplate.upsert).not.toHaveBeenCalled();
  });

  it("rejects an empty template", async () => {
    await expect(updateWhatsAppTemplate("RESULTS_PUBLISHED", "   ")).rejects.toThrow(
      "cannot be empty"
    );
    expect(prisma.whatsAppMessageTemplate.upsert).not.toHaveBeenCalled();
  });

  it("rejects a template with an unknown placeholder (typo) before saving anything", async () => {
    await expect(
      updateWhatsAppTemplate("RESULTS_PUBLISHED", "Hello {studnetName}")
    ).rejects.toThrow(/Unknown placeholder.*\{studnetName\}/);
    expect(prisma.whatsAppMessageTemplate.upsert).not.toHaveBeenCalled();
  });

  it("rejects a placeholder valid for a different event type", async () => {
    await expect(
      updateWhatsAppTemplate("RESULTS_PUBLISHED", "{changeSummary}")
    ).rejects.toThrow(/Unknown placeholder/);
  });

  it("saves a valid template and audits old vs new", async () => {
    await updateWhatsAppTemplate("RESULTS_PUBLISHED", "Hello {studentName}, {mark}!");

    expect(prisma.whatsAppMessageTemplate.upsert).toHaveBeenCalledWith({
      where: { eventType: "RESULTS_PUBLISHED" },
      create: {
        eventType: "RESULTS_PUBLISHED",
        templateText: "Hello {studentName}, {mark}!",
        updatedBy: "admin-1",
      },
      update: { templateText: "Hello {studentName}, {mark}!", updatedBy: "admin-1" },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "WHATSAPP_TEMPLATE_UPDATED",
        entity: "WhatsAppMessageTemplate",
        entityId: "RESULTS_PUBLISHED",
        oldValue: { templateText: "old text" },
        newValue: { templateText: "Hello {studentName}, {mark}!" },
      })
    );
  });

  it("trims surrounding whitespace before saving", async () => {
    await updateWhatsAppTemplate("RESULTS_PUBLISHED", "  Hello {studentName}  ");

    expect(prisma.whatsAppMessageTemplate.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { templateText: "Hello {studentName}", updatedBy: "admin-1" },
      })
    );
  });
});

describe("resetWhatsAppTemplate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.whatsAppMessageTemplate.findUnique).mockResolvedValue({
      eventType: "RESULTS_PUBLISHED",
      templateText: "some edited text",
    } as never);
  });

  it("requires notification.templates.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(resetWhatsAppTemplate("RESULTS_PUBLISHED")).rejects.toThrow("FORBIDDEN");
    expect(prisma.whatsAppMessageTemplate.upsert).not.toHaveBeenCalled();
  });

  it("restores the seeded default text and audits old vs new", async () => {
    await resetWhatsAppTemplate("RESULTS_PUBLISHED");

    expect(prisma.whatsAppMessageTemplate.upsert).toHaveBeenCalledWith({
      where: { eventType: "RESULTS_PUBLISHED" },
      create: {
        eventType: "RESULTS_PUBLISHED",
        templateText: DEFAULT_WHATSAPP_TEMPLATES.RESULTS_PUBLISHED,
        updatedBy: "admin-1",
      },
      update: {
        templateText: DEFAULT_WHATSAPP_TEMPLATES.RESULTS_PUBLISHED,
        updatedBy: "admin-1",
      },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WHATSAPP_TEMPLATE_RESET",
        entity: "WhatsAppMessageTemplate",
        entityId: "RESULTS_PUBLISHED",
        oldValue: { templateText: "some edited text" },
        newValue: { templateText: DEFAULT_WHATSAPP_TEMPLATES.RESULTS_PUBLISHED },
      })
    );
  });
});
