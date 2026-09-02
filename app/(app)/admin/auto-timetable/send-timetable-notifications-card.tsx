"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  previewSendTimetableBatchNotifications,
  sendTimetableBatchNotifications,
  type BatchTimetableNotificationsPreview,
} from "./actions";
import type { WorkloadImportSemesterOption } from "../workload-import/semester-workload-import-client";

interface Props {
  semesterNumberOptions: WorkloadImportSemesterOption[];
}

// Estimated wall-clock time for the worker to drain the batch at one
// message / 5 seconds (see whatsapp-service/ INTER_MESSAGE_DELAY_MS).
function estimateMinutes(count: number): number {
  return Math.max(1, Math.ceil((count * 5) / 60));
}

// Manual, per semester-number batch. Timetable WhatsApp notifications are
// NOT sent automatically on slot edits / auto-generate confirm anymore —
// this one explicit click messages every ACTIVE student in every class at
// the picked level that has a built timetable, plus every lecturer with a
// session in that batch. Lives on the Workload Import & Auto-Timetable
// screen (gated on timetable.generate, same key as auto-generation),
// right alongside "Clear timetable for a semester level" — the two are
// the natural bookends of preparing a batch's timetable. Persistent:
// always reachable after a reload, not tied to having just generated.
export function SendTimetableNotificationsCard({ semesterNumberOptions }: Props) {
  const router = useRouter();
  const [level, setLevel] = useState<number | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [preview, setPreview] = useState<BatchTimetableNotificationsPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [sending, setSending] = useState(false);

  if (semesterNumberOptions.length === 0) return null;

  const alreadySent = !!preview?.lastQueuedAt;

  async function openDialog() {
    if (level === null) return;
    setDialogOpen(true);
    setPreview(null);
    setLoadingPreview(true);
    try {
      setPreview(await previewSendTimetableBatchNotifications(level));
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not check this semester level's timetable."));
      setDialogOpen(false);
    } finally {
      setLoadingPreview(false);
    }
  }

  async function handleSend() {
    if (level === null) return;
    setSending(true);
    try {
      const result = await sendTimetableBatchNotifications(level, alreadySent);
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
          } — sending gradually (about one every 5 seconds, ~${estimateMinutes(total)} min). Check the Delivery Log for status.`
        );
      }
      setDialogOpen(false);
      setPreview(null);
      router.refresh();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not queue timetable notifications."));
      // Preview was stale — someone already sent between the preview and
      // this click. Re-fetch so the warning shows and the button flips to
      // "Resend anyway".
      if (error instanceof Error && error.message === "RECENTLY_SENT" && level !== null) {
        try {
          setPreview(await previewSendTimetableBatchNotifications(level));
        } catch {
          /* keep the current dialog state */
        }
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <Send className="mt-0.5 size-5 text-muted-foreground" />
        <div className="text-sm">
          <p className="font-semibold">Send timetable notifications for a semester level</p>
          <p className="text-muted-foreground">
            WhatsApps every active student in that level&rsquo;s classes and every lecturer teaching
            in them about the current timetable. Not sent automatically on edits — send once the
            week is final. Messages go out gradually (about one every 5 seconds).
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Select
          value={level !== null ? String(level) : null}
          onValueChange={(value) => value && setLevel(Number(value))}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Semester level" />
          </SelectTrigger>
          <SelectContent>
            {semesterNumberOptions.map((opt) => (
              <SelectItem key={opt.semesterNumber} value={String(opt.semesterNumber)}>
                Level {opt.semesterNumber}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" variant="outline" onClick={openDialog} disabled={level === null}>
          <Send className="size-4" />
          Send notifications
        </Button>
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => !sending && setDialogOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send timetable notifications for level {level}?</DialogTitle>
            <DialogDescription>
              {loadingPreview
                ? "Checking who would be notified…"
                : preview
                  ? `Every active student and teaching lecturer for level ${level} in ${preview.semesterLabel}.`
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
              {preview.classCount === 0 ? (
                <p className="rounded-lg border border-border bg-muted/30 p-3 text-muted-foreground">
                  No class at this level has a built timetable yet — nothing to notify anyone about.
                </p>
              ) : (
                <>
                  <p>
                    <span className="font-semibold">{preview.studentCount}</span> student
                    {preview.studentCount === 1 ? "" : "s"} and{" "}
                    <span className="font-semibold">{preview.lecturerCount}</span> lecturer
                    {preview.lecturerCount === 1 ? "" : "s"} across{" "}
                    <span className="font-semibold">{preview.classCount}</span> class
                    {preview.classCount === 1 ? "" : "es"}.{" "}
                    <span className="text-muted-foreground">
                      {preview.withPhoneCount} have a phone number on file and will be messaged.
                    </span>
                  </p>

                  {preview.classes.length > 0 && (
                    <div className="max-h-40 overflow-auto rounded-lg border border-border">
                      <ul className="divide-y divide-border">
                        {preview.classes.map((c) => (
                          <li key={c.classId} className="flex items-center justify-between px-3 py-1.5">
                            <span>{c.className}</span>
                            <span className="text-muted-foreground">
                              {c.studentCount} student{c.studentCount === 1 ? "" : "s"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

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
                        Notifications for this batch were already queued at{" "}
                        {new Date(preview.lastQueuedAt!).toLocaleString()}
                        {preview.stillPending > 0
                          ? ` (${preview.stillPending} still sending)`
                          : ""}
                        . Sending again will message everyone a second time.
                      </p>
                    </div>
                  )}

                  <p className="text-xs text-muted-foreground">
                    Messages are queued now and sent gradually — about one every 5 seconds — so this
                    batch will take roughly {estimateMinutes(preview.withPhoneCount)} minute
                    {estimateMinutes(preview.withPhoneCount) === 1 ? "" : "s"} to finish. Track
                    progress in the Delivery Log (Admin → WhatsApp).
                  </p>
                </>
              )}
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
                preview.classCount === 0 ||
                preview.withPhoneCount === 0
              }
            >
              {sending && <Loader2 className="size-4 animate-spin" />}
              {alreadySent ? "Resend anyway" : "Send notifications"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
