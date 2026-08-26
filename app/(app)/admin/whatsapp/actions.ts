"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { WHATSAPP_SETTINGS_ID, invalidateWhatsAppTemplateCache } from "@/lib/whatsapp-notify";
import {
  AUTOMATIC_EVENTS,
  AUTOMATIC_EVENT_KEYS,
  findUnknownPlaceholders,
  slugifyEventKey,
} from "@/lib/whatsapp-templates";
import { createEventTypeSchema, type CreateEventTypeInput } from "./schema";

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
// lib/permissions.ts's notification.templates.manage comment). Works for
// BOTH AUTOMATIC and MANUAL rows: the row must already exist (created via
// createWhatsAppTemplate below), and its OWN triggerKind/eventKey decide
// which placeholder set the new text is validated against.
export async function updateWhatsAppTemplate(eventKey: string, templateText: string) {
  const admin = await requirePermission("notification.templates.manage");

  const before = await prisma.whatsAppMessageTemplate.findUnique({ where: { eventKey } });
  if (!before) throw new Error("NOT_FOUND");

  const trimmed = templateText.trim();
  if (!trimmed) throw new Error("Template text cannot be empty.");

  // Real typo protection — reject a save with an unrecognized
  // {placeholder} (e.g. {studnetName}) rather than silently storing it;
  // getEffectiveTemplate's own runtime check (AUTOMATIC only) is a
  // second, independent line of defense for a row that somehow got
  // corrupted after the fact (e.g. edited directly in the DB), not a
  // substitute for this one.
  const unknown = findUnknownPlaceholders(before.triggerKind, eventKey, trimmed);
  if (unknown.length > 0) {
    throw new Error(
      `Unknown placeholder${unknown.length > 1 ? "s" : ""}: ${unknown.map((p) => `{${p}}`).join(", ")}`
    );
  }

  await prisma.whatsAppMessageTemplate.update({
    where: { eventKey },
    data: { templateText: trimmed, updatedBy: admin.id },
  });

  invalidateWhatsAppTemplateCache();

  await audit({
    userId: admin.id,
    action: "WHATSAPP_TEMPLATE_UPDATED",
    entity: "WhatsAppMessageTemplate",
    entityId: eventKey,
    oldValue: { templateText: before.templateText },
    newValue: { templateText: trimmed },
  });

  revalidatePath("/admin/whatsapp");
}

// Restores the seeded default text for an AUTOMATIC event type — always
// valid by construction (AUTOMATIC_EVENTS' defaultTemplateText only ever
// uses known placeholders), so no placeholder re-validation is needed
// here. A MANUAL template has no coded default at all, so this throws
// rather than guessing one.
export async function resetWhatsAppTemplate(eventKey: string) {
  const admin = await requirePermission("notification.templates.manage");

  const before = await prisma.whatsAppMessageTemplate.findUnique({ where: { eventKey } });
  if (!before) throw new Error("NOT_FOUND");
  const def = AUTOMATIC_EVENTS[eventKey];
  if (before.triggerKind !== "AUTOMATIC" || !def) {
    throw new Error("NO_DEFAULT_TEXT");
  }

  await prisma.whatsAppMessageTemplate.update({
    where: { eventKey },
    data: { templateText: def.defaultTemplateText, updatedBy: admin.id },
  });

  invalidateWhatsAppTemplateCache();

  await audit({
    userId: admin.id,
    action: "WHATSAPP_TEMPLATE_RESET",
    entity: "WhatsAppMessageTemplate",
    entityId: eventKey,
    oldValue: { templateText: before.templateText },
    newValue: { templateText: def.defaultTemplateText },
  });

  revalidatePath("/admin/whatsapp");
}

// Creates a new event type — the "extensibility" half of this feature.
// AUTOMATIC: eventKey must be one of the code-registered hook keys in
// lib/whatsapp-templates.ts's AUTOMATIC_EVENTS that doesn't already have
// a row — this is what makes
// "a new automatic type can only be created for a hook that already
// exists in code" a real guarantee, not just a UI convention: the
// dropdown only ever offers unregistered keys, and this action re-checks
// server-side regardless of what the client sends. MANUAL: name is
// required, eventKey is derived from it (slugifyEventKey) and must not
// collide with any existing template's key OR any AUTOMATIC key (to
// avoid ever creating an ambiguous key).
export async function createWhatsAppTemplate(input: CreateEventTypeInput) {
  const admin = await requirePermission("notification.templates.manage");
  const data = createEventTypeSchema.parse(input);

  let eventKey: string;
  let name: string;

  if (data.triggerKind === "AUTOMATIC") {
    const def = AUTOMATIC_EVENTS[data.eventKey ?? ""];
    if (!def) throw new Error("UNKNOWN_AUTOMATIC_HOOK");
    const existing = await prisma.whatsAppMessageTemplate.findUnique({
      where: { eventKey: def.key },
    });
    if (existing) throw new Error("ALREADY_EXISTS");
    eventKey = def.key;
    name = data.name?.trim() || def.label;
  } else {
    const trimmedName = (data.name ?? "").trim();
    if (!trimmedName) throw new Error("A name is required.");
    const slug = slugifyEventKey(trimmedName);
    if (!slug) {
      throw new Error("Please choose a name with at least one letter or number.");
    }
    if (AUTOMATIC_EVENT_KEYS.includes(slug)) {
      throw new Error("This name collides with a built-in event type — choose a different name.");
    }
    const existing = await prisma.whatsAppMessageTemplate.findUnique({
      where: { eventKey: slug },
    });
    if (existing) {
      throw new Error("A notification type with this name already exists.");
    }
    eventKey = slug;
    name = trimmedName;
  }

  const trimmedText = data.templateText.trim();
  if (!trimmedText) throw new Error("Template text cannot be empty.");
  const unknown = findUnknownPlaceholders(data.triggerKind, eventKey, trimmedText);
  if (unknown.length > 0) {
    throw new Error(
      `Unknown placeholder${unknown.length > 1 ? "s" : ""}: ${unknown.map((p) => `{${p}}`).join(", ")}`
    );
  }

  const created = await prisma.whatsAppMessageTemplate.create({
    data: {
      eventKey,
      name,
      description: data.description?.trim() || null,
      triggerKind: data.triggerKind,
      isSystem: false,
      templateText: trimmedText,
      updatedBy: admin.id,
    },
  });

  invalidateWhatsAppTemplateCache();

  await audit({
    userId: admin.id,
    action: "WHATSAPP_TEMPLATE_CREATED",
    entity: "WhatsAppMessageTemplate",
    entityId: created.id,
    newValue: { eventKey, name, triggerKind: data.triggerKind, templateText: trimmedText },
  });

  revalidatePath("/admin/whatsapp");
  return created;
}

// Soft-deletes a MANUAL template — never a hard delete (same convention
// as Room/Campus/Shift), and never allowed on an isSystem row regardless
// of triggerKind (defense in depth: isSystem is only ever true for the 3
// original AUTOMATIC built-ins today, but this guard doesn't assume that
// stays true forever). A deactivated template disappears from the Send
// Notification picker and from new sends, but its past deliveries stay
// in the log untouched (no FK from WhatsAppNotificationLog).
export async function deactivateWhatsAppTemplate(id: string) {
  const admin = await requirePermission("notification.templates.manage");

  const template = await prisma.whatsAppMessageTemplate.findUnique({ where: { id } });
  if (!template) throw new Error("NOT_FOUND");
  if (template.isSystem) throw new Error("SYSTEM_TEMPLATE");

  await prisma.whatsAppMessageTemplate.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  invalidateWhatsAppTemplateCache();

  await audit({
    userId: admin.id,
    action: "WHATSAPP_TEMPLATE_DEACTIVATED",
    entity: "WhatsAppMessageTemplate",
    entityId: id,
    oldValue: { eventKey: template.eventKey, name: template.name },
  });

  revalidatePath("/admin/whatsapp");
}

export async function reactivateWhatsAppTemplate(id: string) {
  const admin = await requirePermission("notification.templates.manage");

  const template = await prisma.whatsAppMessageTemplate.findUnique({ where: { id } });
  if (!template) throw new Error("NOT_FOUND");

  await prisma.whatsAppMessageTemplate.update({
    where: { id },
    data: { deletedAt: null },
  });

  invalidateWhatsAppTemplateCache();

  await audit({
    userId: admin.id,
    action: "WHATSAPP_TEMPLATE_REACTIVATED",
    entity: "WhatsAppMessageTemplate",
    entityId: id,
    newValue: { eventKey: template.eventKey, name: template.name },
  });

  revalidatePath("/admin/whatsapp");
}
