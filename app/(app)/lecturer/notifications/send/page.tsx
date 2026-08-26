import { SendNotificationPanel } from "../../../admin/notifications/send/panel";

// Same panel as /admin/notifications/send — see that file's comment for
// why the scoping is safe regardless of which route rendered it.
export default async function LecturerSendNotificationPage() {
  return <SendNotificationPanel />;
}
