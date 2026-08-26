import { redirect } from "next/navigation";
import type { Prisma, WhatsAppNotificationStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getSessionContext } from "@/lib/auth";
import { resolvePageParams } from "@/lib/pagination";
import { WHATSAPP_SETTINGS_ID } from "@/lib/whatsapp-notify";
import { AUTOMATIC_EVENT_KEYS } from "@/lib/whatsapp-templates";
import { WhatsAppClient } from "./whatsapp-client";

export interface WhatsAppSearchParams {
  status?: string;
  eventType?: string;
  q?: string;
  page?: string;
  pageSize?: string;
}

// A log table warrants a bigger default page size — same reasoning as
// Audit Logs (25 instead of the usual 10).
export async function WhatsAppPanel({
  searchParams,
}: {
  searchParams: WhatsAppSearchParams;
}) {
  // The admin layout's outer gate accepts ANY admin-category permission —
  // this page belongs to whoever holds EITHER whatsapp.manage (settings/
  // delivery log) or notification.templates.manage (message wording),
  // since a future custom role could hold just one of them (see
  // lib/permissions.ts); each tab/action still checks its own specific
  // key beyond this, same "each page/action checks its own specific key"
  // principle as every Server Action in this app.
  const ctx = await getSessionContext();
  if (!ctx?.permissions.has("whatsapp.manage") && !ctx?.permissions.has("notification.templates.manage")) {
    redirect("/");
  }

  const { page, pageSize, skip, take } = resolvePageParams(searchParams, 25);

  const where: Prisma.WhatsAppNotificationLogWhereInput = {
    ...(searchParams.status && searchParams.status !== "all"
      ? { status: searchParams.status as WhatsAppNotificationStatus }
      : {}),
    ...(searchParams.eventType && searchParams.eventType !== "all"
      ? { eventKey: searchParams.eventType }
      : {}),
    ...(searchParams.q
      ? {
          OR: [
            { recipientName: { contains: searchParams.q, mode: "insensitive" } },
            { phoneNumber: { contains: searchParams.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [settings, logs, total, pendingCount, failedCount, templates] = await Promise.all([
    prisma.whatsAppSettings.findUnique({ where: { id: WHATSAPP_SETTINGS_ID } }),
    prisma.whatsAppNotificationLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    prisma.whatsAppNotificationLog.count({ where }),
    prisma.whatsAppNotificationLog.count({ where: { status: "PENDING" } }),
    prisma.whatsAppNotificationLog.count({ where: { status: "FAILED" } }),
    prisma.whatsAppMessageTemplate.findMany({
      include: { updatedByUser: { select: { fullName: true } } },
      orderBy: [{ triggerKind: "asc" }, { name: "asc" }],
    }),
  ]);

  // Which registered automatic hooks don't have a template row yet — the
  // "Create new event type" dialog's AUTOMATIC option only ever offers
  // these, both so the picker can't suggest something already covered
  // and so it can show "none available" once every hook has a row (true
  // today: all 3 original built-ins are seeded).
  const templatedKeys = new Set(templates.map((t) => t.eventKey));
  const availableAutomaticKeys = AUTOMATIC_EVENT_KEYS.filter((k) => !templatedKeys.has(k));

  return (
    <WhatsAppClient
      settings={settings}
      logs={logs}
      total={total}
      page={page}
      pageSize={pageSize}
      pendingCount={pendingCount}
      failedCount={failedCount}
      templates={templates}
      availableAutomaticKeys={availableAutomaticKeys}
      canManageTemplates={ctx.permissions.has("notification.templates.manage")}
    />
  );
}
