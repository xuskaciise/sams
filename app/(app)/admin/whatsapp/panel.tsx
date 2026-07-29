import { redirect } from "next/navigation";
import type {
  Prisma,
  WhatsAppNotificationStatus,
  WhatsAppEventType,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { getSessionContext } from "@/lib/auth";
import { resolvePageParams } from "@/lib/pagination";
import { WHATSAPP_SETTINGS_ID } from "@/lib/whatsapp-notify";
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
  // whatsapp.manage is the one specific key that actually belongs on
  // this page (there's no separate "view" key, see lib/permissions.ts),
  // so it's checked here too, same "each page checks its own specific
  // key" principle as every Server Action in this app.
  const ctx = await getSessionContext();
  if (!ctx?.permissions.has("whatsapp.manage")) {
    redirect("/");
  }

  const { page, pageSize, skip, take } = resolvePageParams(searchParams, 25);

  const where: Prisma.WhatsAppNotificationLogWhereInput = {
    ...(searchParams.status && searchParams.status !== "all"
      ? { status: searchParams.status as WhatsAppNotificationStatus }
      : {}),
    ...(searchParams.eventType && searchParams.eventType !== "all"
      ? { eventType: searchParams.eventType as WhatsAppEventType }
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

  const [settings, logs, total, pendingCount, failedCount] = await Promise.all([
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
  ]);

  return (
    <WhatsAppClient
      settings={settings}
      logs={logs}
      total={total}
      page={page}
      pageSize={pageSize}
      pendingCount={pendingCount}
      failedCount={failedCount}
    />
  );
}
