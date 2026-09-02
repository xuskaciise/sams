"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { getActionErrorMessage } from "@/lib/action-error";
import {
  previewClassTimetableNotifications,
  sendClassTimetableNotifications,
  type ClassTimetableNotificationsPreview,
} from "./actions";

interface Props {
  classId: string;
  semesterId: string;
}

function estimateMinutes(count: number): number {
  return Math.max(1, Math.ceil((count * 5) / 60));
}

// Per-class counterpart to the semester-batch "Send timetable
// notifications" card on Workload Import & Auto-Timetable. Sits next to
// "Clear timetable" on the Builder — after finishing ad-hoc changes to
// one class's week, one click WhatsApps that class's active students and
// its teaching lecturers. Nothing is sent automatically on the individual
// drag/drop/edit actions anymore.
export function SendClassTimetableNotificationsButton({ classId, semesterId }: Props) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [preview, setPreview] = useState<ClassTimetableNotificationsPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [sending, setSending] = useState(false);

  const alreadySent = !!preview?.lastQueuedAt;

  async function openDialog() {
    setDialogOpen(true);
    setPreview(null);
    setLoadingPreview(true);
    try {
      setPreview(await previewClassTimetableNotifications(classId, semesterId));
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not check who would be notified."));
      setDialogOpen(false);
    } finally {
      setLoadingPreview(false);
    }
  }

  async function handleSend() {
    setSending(true);
    try {
      const result = await sendClassTimetableNotifications(classId, semesterId, alreadySent);
      const total = result.enqueuedStudents + result.enqueuedLecturers;
      if (total === 0) {
        toast.info(
          result.whatsappEnabled
            ? "Nothing queued — no recipients have a phone number on file."
            : "Nothing queued — WhatsApp notifications are turned off (Admin → WhatsApp)."
        );
      } else {
        toast.success(
          `Notifications queued for ${result.enqueuedStudents} student${
            result.enqueuedStudents === 1 ? "" : "s"
          } and ${result.enqueuedLecturers} lecturer${
            result.enqueuedLecturers === 1 ? "" : "s"
          } — sending gradually (about one every 5 seconds, ~${estimateMinutes(total)} min). Check the Delivery Log.`
        );
      }
      setDialogOpen(false);
      setPreview(null);
      router.refresh();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not queue notifications."));
      if (error instanceof Error && error.message === "RECENTLY_SENT") {
        try {
          setPreview(await previewClassTimetableNotifications(classId, semesterId));
        } catch {
          /* keep the current dialog state */
        }
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={openDialog}>
        <Send className="size-4" />
        Send notifications
      </Button>

      <Dialog open={dialogOpen} onOpenChange={(open) => !sending && setDialogOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send timetable notifications{preview ? ` for ${preview.className}` : ""}?</DialogTitle>
            <DialogDescription>
              {loadingPreview
                ? "Checking who would be notified…"
                : preview
                  ? `Every active student in ${preview.className} and every lecturer teaching it in ${preview.semesterLabel}.`
                  : "Could not load a preview."}
            </DialogDescription>
          </DialogHeader>

          {loadingPreview && (
            <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading…
            </div>
          )}

          {!loadingPreview && preview && (
            <div className="space-y-3 text-sm">
              <p>
                <span className="font-semibold">{preview.studentCount}</span> student
                {preview.studentCount === 1 ? "" : "s"} and{" "}
                <span className="font-semibold">{preview.lecturerCount}</span> lecturer
                {preview.lecturerCount === 1 ? "" : "s"}.{" "}
                <span className="text-muted-foreground">
                  {preview.withPhoneCount} have a phone number on file and will be messaged.
                </span>
              </p>

              {!preview.whatsappEnabled && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <p>
                    WhatsApp notifications are turned off. Turn them on at Admin → WhatsApp first —
                    nothing will be sent until then.
                  </p>
                </div>
              )}

              {alreadySent && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <p>
                    Notifications for this class were already queued at{" "}
                    {new Date(preview.lastQueuedAt!).toLocaleString()}
                    {preview.stillPending > 0 ? ` (${preview.stillPending} still sending)` : ""}.
                    Sending again will message everyone a second time.
                  </p>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                Messages are queued now and sent gradually — about one every 5 seconds — so this will
                take roughly {estimateMinutes(preview.withPhoneCount)} minute
                {estimateMinutes(preview.withPhoneCount) === 1 ? "" : "s"} to finish. Track progress
                in the Delivery Log (Admin → WhatsApp).
              </p>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} disabled={sending}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSend}
              disabled={
                sending ||
                loadingPreview ||
                !preview ||
                !preview.whatsappEnabled ||
                preview.withPhoneCount === 0
              }
            >
              {sending && <Loader2 className="size-4 animate-spin" />}
              {alreadySent ? "Resend anyway" : "Send notifications"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
