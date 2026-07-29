import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAdmin = { id: "admin-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    whatsAppSettings: { findUnique: vi.fn(), update: vi.fn() },
    whatsAppNotificationLog: { findUnique: vi.fn(), update: vi.fn() },
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
import { setWhatsAppEnabled, retryWhatsAppNotification } from "./actions";

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
