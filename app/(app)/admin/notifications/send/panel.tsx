import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth";
import { getSendNotificationData } from "./queries";
import { SendNotificationClient } from "./send-notification-client";

// Shared by all three routes — /admin/notifications/send,
// /dean/notifications/send, /lecturer/notifications/send — same "one
// implementation, multiple routes" pattern as Daily Log/Timetable/
// Workload Import. The real scoping boundary is re-derived from the
// caller's ROLE inside getSendNotificationData/recipients.ts, not from
// which route rendered this panel.
export async function SendNotificationPanel() {
  const ctx = await getSessionContext();
  if (!ctx || !ctx.permissions.has("notification.send.manual")) {
    redirect("/");
  }

  const data = await getSendNotificationData(ctx.user.id);

  return <SendNotificationClient data={data} senderName={ctx.user.fullName} />;
}
