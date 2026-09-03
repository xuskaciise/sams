import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAdmin = { id: "admin-1" };

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    whatsAppSettings: { findUnique: vi.fn(), update: vi.fn() },
    whatsAppNotificationLog: { findUnique: vi.fn(), update: vi.fn() },
    whatsAppMessageTemplate: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
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
import { AUTOMATIC_EVENTS } from "@/lib/whatsapp-templates";
import {
  setWhatsAppEnabled,
  setWhatsAppDomain,
  retryWhatsAppNotification,
  updateWhatsAppTemplate,
  resetWhatsAppTemplate,
  createWhatsAppTemplate,
  deactivateWhatsAppTemplate,
  reactivateWhatsAppTemplate,
} from "./actions";

describe("setWhatsAppDomain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.whatsAppSettings.findUnique).mockResolvedValue({
      id: "singleton",
      domainName: null,
    } as never);
  });

  it("requires whatsapp.manage", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));
    await expect(setWhatsAppDomain("x.edu")).rejects.toThrow("FORBIDDEN");
    expect(prisma.whatsAppSettings.update).not.toHaveBeenCalled();
  });

  it("trims and stores the domain, and audits old -> new", async () => {
    await setWhatsAppDomain("  sams.university.edu  ");

    expect(prisma.whatsAppSettings.update).toHaveBeenCalledWith({
      where: { id: "singleton" },
      data: { domainName: "sams.university.edu" },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WHATSAPP_DOMAIN_UPDATED",
        oldValue: { domainName: null },
        newValue: { domainName: "sams.university.edu" },
      })
    );
  });

  it("clears the domain to null when given an empty value", async () => {
    await setWhatsAppDomain("   ");
    expect(prisma.whatsAppSettings.update).toHaveBeenCalledWith({
      where: { id: "singleton" },
      data: { domainName: null },
    });
  });
});

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
      eventKey: "RESULTS_PUBLISHED",
      triggerKind: "AUTOMATIC",
      templateText: "old text",
    } as never);
  });

  it("requires notification.templates.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(
      updateWhatsAppTemplate("RESULTS_PUBLISHED", "Hello {studentName}")
    ).rejects.toThrow("FORBIDDEN");
    expect(prisma.whatsAppMessageTemplate.update).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND for a nonexistent eventKey", async () => {
    vi.mocked(prisma.whatsAppMessageTemplate.findUnique).mockResolvedValue(null);

    await expect(updateWhatsAppTemplate("NOPE", "text")).rejects.toThrow("NOT_FOUND");
  });

  it("rejects an empty template", async () => {
    await expect(updateWhatsAppTemplate("RESULTS_PUBLISHED", "   ")).rejects.toThrow(
      "cannot be empty"
    );
    expect(prisma.whatsAppMessageTemplate.update).not.toHaveBeenCalled();
  });

  it("rejects a template with an unknown placeholder (typo) before saving anything", async () => {
    await expect(
      updateWhatsAppTemplate("RESULTS_PUBLISHED", "Hello {studnetName}")
    ).rejects.toThrow(/Unknown placeholder.*\{studnetName\}/);
    expect(prisma.whatsAppMessageTemplate.update).not.toHaveBeenCalled();
  });

  it("rejects a placeholder valid for a different event type", async () => {
    await expect(
      updateWhatsAppTemplate("RESULTS_PUBLISHED", "{changeSummary}")
    ).rejects.toThrow(/Unknown placeholder/);
  });

  it("saves a valid template and audits old vs new", async () => {
    await updateWhatsAppTemplate("RESULTS_PUBLISHED", "Hello {studentName}, {mark}!");

    expect(prisma.whatsAppMessageTemplate.update).toHaveBeenCalledWith({
      where: { eventKey: "RESULTS_PUBLISHED" },
      data: { templateText: "Hello {studentName}, {mark}!", updatedBy: "admin-1" },
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

    expect(prisma.whatsAppMessageTemplate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { templateText: "Hello {studentName}", updatedBy: "admin-1" },
      })
    );
  });

  it("validates a MANUAL row's text against the shared manual placeholder set, not an automatic one's", async () => {
    vi.mocked(prisma.whatsAppMessageTemplate.findUnique).mockResolvedValue({
      eventKey: "UNIVERSITY_HOLIDAY",
      triggerKind: "MANUAL",
      templateText: "old text",
    } as never);

    await expect(
      updateWhatsAppTemplate("UNIVERSITY_HOLIDAY", "{assessmentTitle}")
    ).rejects.toThrow(/Unknown placeholder/);

    await updateWhatsAppTemplate("UNIVERSITY_HOLIDAY", "Hi {recipientName}: {message}");
    expect(prisma.whatsAppMessageTemplate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventKey: "UNIVERSITY_HOLIDAY" },
      })
    );
  });
});

describe("resetWhatsAppTemplate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.whatsAppMessageTemplate.findUnique).mockResolvedValue({
      eventKey: "RESULTS_PUBLISHED",
      triggerKind: "AUTOMATIC",
      templateText: "some edited text",
    } as never);
  });

  it("requires notification.templates.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(resetWhatsAppTemplate("RESULTS_PUBLISHED")).rejects.toThrow("FORBIDDEN");
    expect(prisma.whatsAppMessageTemplate.update).not.toHaveBeenCalled();
  });

  it("restores the seeded default text and audits old vs new (subject stays null for a WhatsApp event)", async () => {
    await resetWhatsAppTemplate("RESULTS_PUBLISHED");

    expect(prisma.whatsAppMessageTemplate.update).toHaveBeenCalledWith({
      where: { eventKey: "RESULTS_PUBLISHED" },
      data: {
        templateText: AUTOMATIC_EVENTS.RESULTS_PUBLISHED.defaultTemplateText,
        subject: null,
        updatedBy: "admin-1",
      },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WHATSAPP_TEMPLATE_RESET",
        entity: "WhatsAppMessageTemplate",
        entityId: "RESULTS_PUBLISHED",
        oldValue: expect.objectContaining({ templateText: "some edited text" }),
        newValue: expect.objectContaining({
          templateText: AUTOMATIC_EVENTS.RESULTS_PUBLISHED.defaultTemplateText,
        }),
      })
    );
  });

  it("resets an EMAIL event's subject back to its coded default too", async () => {
    vi.mocked(prisma.whatsAppMessageTemplate.findUnique).mockResolvedValue({
      eventKey: "RESULTS_PUBLISHED_EMAIL",
      triggerKind: "AUTOMATIC",
      templateText: "edited body",
      subject: "edited subject",
    } as never);

    await resetWhatsAppTemplate("RESULTS_PUBLISHED_EMAIL");

    expect(prisma.whatsAppMessageTemplate.update).toHaveBeenCalledWith({
      where: { eventKey: "RESULTS_PUBLISHED_EMAIL" },
      data: {
        templateText: AUTOMATIC_EVENTS.RESULTS_PUBLISHED_EMAIL.defaultTemplateText,
        subject: AUTOMATIC_EVENTS.RESULTS_PUBLISHED_EMAIL.defaultSubject,
        updatedBy: "admin-1",
      },
    });
  });

  it("refuses to reset a MANUAL template — it has no coded default", async () => {
    vi.mocked(prisma.whatsAppMessageTemplate.findUnique).mockResolvedValue({
      eventKey: "UNIVERSITY_HOLIDAY",
      triggerKind: "MANUAL",
      templateText: "some text",
    } as never);

    await expect(resetWhatsAppTemplate("UNIVERSITY_HOLIDAY")).rejects.toThrow(
      "NO_DEFAULT_TEXT"
    );
    expect(prisma.whatsAppMessageTemplate.update).not.toHaveBeenCalled();
  });
});

describe("createWhatsAppTemplate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
    vi.mocked(prisma.whatsAppMessageTemplate.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.whatsAppMessageTemplate.create).mockResolvedValue({
      id: "tpl-1",
    } as never);
  });

  it("requires notification.templates.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(
      createWhatsAppTemplate({
        triggerKind: "MANUAL",
        name: "University Holiday",
        templateText: "Hi {recipientName}",
      })
    ).rejects.toThrow("FORBIDDEN");
    expect(prisma.whatsAppMessageTemplate.create).not.toHaveBeenCalled();
  });

  it("creates a MANUAL template with a slugified eventKey derived from the name", async () => {
    await createWhatsAppTemplate({
      triggerKind: "MANUAL",
      name: "University Holiday",
      description: "For public holidays",
      templateText: "Hi {recipientName}: {message}",
    });

    expect(prisma.whatsAppMessageTemplate.create).toHaveBeenCalledWith({
      data: {
        eventKey: "UNIVERSITY_HOLIDAY",
        name: "University Holiday",
        description: "For public holidays",
        triggerKind: "MANUAL",
        isSystem: false,
        templateText: "Hi {recipientName}: {message}",
        updatedBy: "admin-1",
      },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "WHATSAPP_TEMPLATE_CREATED", entityId: "tpl-1" })
    );
  });

  it("rejects a MANUAL name that collides with an existing template's eventKey", async () => {
    vi.mocked(prisma.whatsAppMessageTemplate.findUnique).mockResolvedValue({
      eventKey: "UNIVERSITY_HOLIDAY",
    } as never);

    await expect(
      createWhatsAppTemplate({
        triggerKind: "MANUAL",
        name: "University Holiday",
        templateText: "Hi {recipientName}",
      })
    ).rejects.toThrow("already exists");
    expect(prisma.whatsAppMessageTemplate.create).not.toHaveBeenCalled();
  });

  it("rejects a MANUAL name that collides with a built-in automatic key", async () => {
    await expect(
      createWhatsAppTemplate({
        triggerKind: "MANUAL",
        name: "Results Published",
        templateText: "Hi {recipientName}",
      })
    ).rejects.toThrow("collides with a built-in");
  });

  it("rejects a MANUAL name with no letters or digits", async () => {
    await expect(
      createWhatsAppTemplate({
        triggerKind: "MANUAL",
        name: "!!!",
        templateText: "Hi {recipientName}",
      })
    ).rejects.toThrow("at least one letter or number");
  });

  it("rejects a MANUAL template using an AUTOMATIC-only placeholder", async () => {
    await expect(
      createWhatsAppTemplate({
        triggerKind: "MANUAL",
        name: "University Holiday",
        templateText: "{assessmentTitle}",
      })
    ).rejects.toThrow(/Unknown placeholder/);
  });

  it("creates an AUTOMATIC template only for a registered, not-yet-templated hook key", async () => {
    await expect(
      createWhatsAppTemplate({
        triggerKind: "AUTOMATIC",
        eventKey: "NOT_A_REAL_HOOK",
        templateText: "Hello {studentName}",
      })
    ).rejects.toThrow("UNKNOWN_AUTOMATIC_HOOK");
    expect(prisma.whatsAppMessageTemplate.create).not.toHaveBeenCalled();
  });

  it("rejects creating an AUTOMATIC template for a hook that already has one", async () => {
    vi.mocked(prisma.whatsAppMessageTemplate.findUnique).mockResolvedValue({
      eventKey: "RESULTS_PUBLISHED",
    } as never);

    await expect(
      createWhatsAppTemplate({
        triggerKind: "AUTOMATIC",
        eventKey: "RESULTS_PUBLISHED",
        templateText: "Hello {studentName}",
      })
    ).rejects.toThrow("ALREADY_EXISTS");
  });

  it("defaults an AUTOMATIC template's name to the registry label when none is given", async () => {
    await createWhatsAppTemplate({
      triggerKind: "AUTOMATIC",
      eventKey: "RESULTS_PUBLISHED",
      templateText: "Hello {studentName}",
    });

    expect(prisma.whatsAppMessageTemplate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "Results published", isSystem: false }),
      })
    );
  });
});

describe("deactivateWhatsAppTemplate / reactivateWhatsAppTemplate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePermission).mockResolvedValue(mockAdmin as never);
  });

  it("requires notification.templates.manage before touching anything", async () => {
    vi.mocked(requirePermission).mockRejectedValue(new Error("FORBIDDEN"));

    await expect(deactivateWhatsAppTemplate("tpl-1")).rejects.toThrow("FORBIDDEN");
    expect(prisma.whatsAppMessageTemplate.update).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND for a nonexistent template", async () => {
    vi.mocked(prisma.whatsAppMessageTemplate.findUnique).mockResolvedValue(null);

    await expect(deactivateWhatsAppTemplate("missing")).rejects.toThrow("NOT_FOUND");
  });

  it("refuses to deactivate a system (built-in automatic) template", async () => {
    vi.mocked(prisma.whatsAppMessageTemplate.findUnique).mockResolvedValue({
      id: "tpl-1",
      isSystem: true,
      eventKey: "RESULTS_PUBLISHED",
      name: "Results published",
    } as never);

    await expect(deactivateWhatsAppTemplate("tpl-1")).rejects.toThrow("SYSTEM_TEMPLATE");
    expect(prisma.whatsAppMessageTemplate.update).not.toHaveBeenCalled();
  });

  it("soft-deactivates a MANUAL template and audits it", async () => {
    vi.mocked(prisma.whatsAppMessageTemplate.findUnique).mockResolvedValue({
      id: "tpl-1",
      isSystem: false,
      eventKey: "UNIVERSITY_HOLIDAY",
      name: "University Holiday",
    } as never);

    await deactivateWhatsAppTemplate("tpl-1");

    expect(prisma.whatsAppMessageTemplate.update).toHaveBeenCalledWith({
      where: { id: "tpl-1" },
      data: { deletedAt: expect.any(Date) },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "WHATSAPP_TEMPLATE_DEACTIVATED", entityId: "tpl-1" })
    );
  });

  it("reactivates a deactivated template", async () => {
    vi.mocked(prisma.whatsAppMessageTemplate.findUnique).mockResolvedValue({
      id: "tpl-1",
      isSystem: false,
      eventKey: "UNIVERSITY_HOLIDAY",
      name: "University Holiday",
    } as never);

    await reactivateWhatsAppTemplate("tpl-1");

    expect(prisma.whatsAppMessageTemplate.update).toHaveBeenCalledWith({
      where: { id: "tpl-1" },
      data: { deletedAt: null },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "WHATSAPP_TEMPLATE_REACTIVATED", entityId: "tpl-1" })
    );
  });
});
