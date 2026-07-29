"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { WHATSAPP_SETTINGS_ID } from "@/lib/whatsapp-notify";

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
