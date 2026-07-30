"use server";

import { revalidatePath } from "next/cache";
import type { WhatsAppEventType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { WHATSAPP_SETTINGS_ID, invalidateWhatsAppTemplateCache } from "@/lib/whatsapp-notify";
import { DEFAULT_WHATSAPP_TEMPLATES, findUnknownPlaceholders } from "@/lib/whatsapp-templates";

// The whole feature's kill switch — off by default (see the migration's
// singleton insert). Flipping this to false doesn't touch the queue: any
// PENDING rows just sit there until re-enabled, they're never dropped.
export async function setWhatsAppEnabled(enabled: boolean) {
  const admin = await requirePermission("whatsapp.manage");

  const before = await prisma.whatsAppSettings.findUnique({
    where: { id: WHATSAPP_SETTINGS_ID },
  });

  await prisma.whatsAppSettings.update({
    where: { id: WHATSAPP_SETTINGS_ID },
    data: { enabled },
  });

  await audit({
    userId: admin.id,
    action: "WHATSAPP_TOGGLED",
    entity: "WhatsAppSettings",
    entityId: WHATSAPP_SETTINGS_ID,
    oldValue: { enabled: before?.enabled ?? false },
    newValue: { enabled },
  });

  revalidatePath("/admin/whatsapp");
}

// Flips a FAILED row back to PENDING so the VPS worker's next poll picks
// it up again — this page never talks to the worker directly, same
// DB-mediated coordination as the rest of this feature (see
// WhatsAppSettings' schema comment).
export async function retryWhatsAppNotification(id: string) {
  const admin = await requirePermission("whatsapp.manage");

  const log = await prisma.whatsAppNotificationLog.findUnique({ where: { id } });
  if (!log) throw new Error("NOT_FOUND");
  if (log.status !== "FAILED") throw new Error("NOT_FAILED");

  await prisma.whatsAppNotificationLog.update({
    where: { id },
    data: { status: "PENDING", lastError: null },
  });

  await audit({
    userId: admin.id,
    action: "WHATSAPP_NOTIFICATION_RETRIED",
    entity: "WhatsAppNotificationLog",
    entityId: id,
  });

  revalidatePath("/admin/whatsapp");
}

// Separate permission from whatsapp.manage — message wording is a
// distinct concern from the on/off switch/delivery log (see
// lib/permissions.ts's notification.templates.manage comment).
export async function updateWhatsAppTemplate(eventType: WhatsAppEventType, templateText: string) {
  const admin = await requirePermission("notification.templates.manage");

  const trimmed = templateText.trim();
  if (!trimmed) throw new Error("Template text cannot be empty.");

  // Real typo protection — reject a save with an unrecognized
  // {placeholder} (e.g. {studnetName}) rather than silently storing it;
  // getEffectiveTemplate's own runtime check is a second, independent
  // line of defense for a row that somehow got corrupted after the fact
  // (e.g. edited directly in the DB), not a substitute for this one.
  const unknown = findUnknownPlaceholders(eventType, trimmed);
  if (unknown.length > 0) {
    throw new Error(
      `Unknown placeholder${unknown.length > 1 ? "s" : ""}: ${unknown.map((p) => `{${p}}`).join(", ")}`
    );
  }

  const before = await prisma.whatsAppMessageTemplate.findUnique({ where: { eventType } });

  await prisma.whatsAppMessageTemplate.upsert({
    where: { eventType },
    create: { eventType, templateText: trimmed, updatedBy: admin.id },
    update: { templateText: trimmed, updatedBy: admin.id },
  });

  invalidateWhatsAppTemplateCache();

  await audit({
    userId: admin.id,
    action: "WHATSAPP_TEMPLATE_UPDATED",
    entity: "WhatsAppMessageTemplate",
    entityId: eventType,
    oldValue: { templateText: before?.templateText ?? null },
    newValue: { templateText: trimmed },
  });

  revalidatePath("/admin/whatsapp");
}

// Restores the seeded default text for one event type — always valid by
// construction (DEFAULT_WHATSAPP_TEMPLATES only ever uses known
// placeholders), so no placeholder re-validation is needed here.
export async function resetWhatsAppTemplate(eventType: WhatsAppEventType) {
  const admin = await requirePermission("notification.templates.manage");

  const before = await prisma.whatsAppMessageTemplate.findUnique({ where: { eventType } });
  const defaultText = DEFAULT_WHATSAPP_TEMPLATES[eventType];

  await prisma.whatsAppMessageTemplate.upsert({
    where: { eventType },
    create: { eventType, templateText: defaultText, updatedBy: admin.id },
    update: { templateText: defaultText, updatedBy: admin.id },
  });

  invalidateWhatsAppTemplateCache();

  await audit({
    userId: admin.id,
    action: "WHATSAPP_TEMPLATE_RESET",
    entity: "WhatsAppMessageTemplate",
    entityId: eventType,
    oldValue: { templateText: before?.templateText ?? null },
    newValue: { templateText: defaultText },
  });

  revalidatePath("/admin/whatsapp");
}
