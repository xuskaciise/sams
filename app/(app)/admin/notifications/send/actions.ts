"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { sendManualNotification as enqueueManualNotification } from "@/lib/whatsapp-notify";
import { findUnknownPlaceholders } from "@/lib/whatsapp-templates";
import { resolveSenderScope, resolveManualRecipients } from "./recipients";
import {
  sendManualNotificationSchema,
  previewManualNotificationSchema,
  type SendManualNotificationInput,
  type PreviewManualNotificationInput,
} from "./schema";

const RECIPIENT_PREVIEW_LIMIT = 20;

export interface RecipientPreview {
  count: number;
  sample: { name: string; className?: string }[];
  truncated: boolean;
  skippedNoPhone: number;
}

// Read-only — resolves exactly what a real send would target, so the
// compose form can show "this will message N recipient(s)" (and a short
// sample list) before the sender commits. Reuses the SAME resolution
// resolveManualRecipients that the real send below uses, so the two can
// never disagree.
export async function previewManualNotificationRecipients(
  input: PreviewManualNotificationInput
): Promise<RecipientPreview> {
  const user = await requirePermission("notification.send.manual");
  const data = previewManualNotificationSchema.parse(input);

  const scope = await resolveSenderScope(user.id);
  const { recipients } = await resolveManualRecipients({
    scope,
    recipientKind: data.recipientKind,
    target: data.target,
    targetId: data.targetId,
  });

  const withPhone = recipients.filter((r) => r.phoneNumber);
  return {
    count: recipients.length,
    sample: withPhone
      .slice(0, RECIPIENT_PREVIEW_LIMIT)
      .map((r) => ({ name: r.name, className: r.className })),
    truncated: withPhone.length > RECIPIENT_PREVIEW_LIMIT,
    skippedNoPhone: recipients.length - withPhone.length,
  };
}

export interface SendManualNotificationResult {
  recipientCount: number;
  enqueued: number;
  skippedNoPhoneOrDisabled: number;
}

// The actual send. Never trusts a client-supplied recipient list — the
// recipient set is entirely re-resolved here, server-side, from
// (recipientKind, target, targetId) plus the caller's own scope, exactly
// like the preview above. Audited as ONE summary entry regardless of how
// many recipients were reached, matching this app's established
// one-entry-per-batch-operation convention (BULK_ASSIGNED,
// TIMETABLE_WEEK_BUILT, WORKLOAD_IMPORTED, …) rather than one row per
// recipient — the per-recipient record already lives in
// WhatsAppNotificationLog.
export async function sendManualNotification(
  input: SendManualNotificationInput
): Promise<SendManualNotificationResult> {
  const user = await requirePermission("notification.send.manual");
  const data = sendManualNotificationSchema.parse(input);

  const template = await prisma.whatsAppMessageTemplate.findFirst({
    where: { id: data.templateId, triggerKind: "MANUAL", deletedAt: null },
  });
  if (!template) throw new Error("NOT_FOUND");

  // Defense in depth — a MANUAL template is validated at create/edit
  // time and should always be well-formed, but this action has no coded
  // default to fall back to the way AUTOMATIC sends do (see
  // lib/whatsapp-notify.ts's getEffectiveAutomaticTemplate), so a
  // template that somehow went bad (e.g. edited directly in the DB) is
  // refused outright rather than risking a broken/literal message.
  if (findUnknownPlaceholders("MANUAL", template.eventKey, template.templateText).length > 0) {
    throw new Error("INVALID_TEMPLATE");
  }

  const scope = await resolveSenderScope(user.id);
  const { recipients, facultyName } = await resolveManualRecipients({
    scope,
    recipientKind: data.recipientKind,
    target: data.target,
    targetId: data.targetId,
  });

  const { enqueued, skippedNoPhoneOrDisabled } = await enqueueManualNotification({
    templateId: template.id,
    eventKey: template.eventKey,
    templateText: template.templateText,
    senderName: user.fullName,
    message: data.message,
    facultyName,
    recipients,
  });

  await audit({
    userId: user.id,
    action: "WHATSAPP_MANUAL_SENT",
    entity: "WhatsAppMessageTemplate",
    entityId: template.id,
    newValue: {
      templateName: template.name,
      eventKey: template.eventKey,
      recipientKind: data.recipientKind,
      target: data.target,
      recipientCount: recipients.length,
      enqueued,
      skippedNoPhoneOrDisabled,
    },
  });

  revalidatePath("/admin/whatsapp");

  return { recipientCount: recipients.length, enqueued, skippedNoPhoneOrDisabled };
}
