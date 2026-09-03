"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Check, Loader2, Users } from "lucide-react";
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
  previewClassTimetableGroupShare,
  shareClassTimetableToGroup,
  type ClassTimetableGroupSharePreview,
} from "./actions";

interface Props {
  classId: string;
  semesterId: string;
}

// "Share timetable to WhatsApp Group" — per class, on the Timetable
// Builder (next to "Send notifications" / "Clear timetable"). Placed here
// because this is where a class's finalized week is reviewed/adjusted.
// Opens a PHONE-NUMBER-LESS wa.me link (https://wa.me/?text=...) so the
// admin/dean picks the class's own student WhatsApp GROUP in WhatsApp and
// forwards it manually — the app never learns which group and sends
// NOTHING. Records only that it was shared (for the "already shared …
// Share again" soft-block). Students still get zero automated WhatsApp.
export function ShareClassTimetableGroupButton({ classId, semesterId }: Props) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [preview, setPreview] = useState<ClassTimetableGroupSharePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [sharing, setSharing] = useState(false);

  const alreadyShared = !!preview?.lastSharedAt;

  async function openDialog() {
    setDialogOpen(true);
    setPreview(null);
    setLoading(true);
    try {
      setPreview(await previewClassTimetableGroupShare(classId, semesterId));
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not prepare the share link."));
      setDialogOpen(false);
    } finally {
      setLoading(false);
    }
  }

  async function handleShare() {
    // Open the blank tab SYNCHRONOUSLY inside the click — a window.open
    // after an awaited server call is blocked by popup blockers. Point it
    // at the wa.me URL once the action resolves, or close it on failure.
    const win = window.open("", "_blank");
    setSharing(true);
    try {
      const { url } = await shareClassTimetableToGroup(classId, semesterId, alreadyShared);
      if (win) win.location.href = url;
      else window.open(url, "_blank");
      toast.success("WhatsApp opened — pick your class's group and hit Send there.");
      setDialogOpen(false);
      setPreview(null);
      router.refresh();
    } catch (error) {
      win?.close();
      const message = error instanceof Error ? error.message : "";
      if (message === "ALREADY_SHARED") {
        // Refresh the preview so the "already shared" banner + "Share
        // again" button show (the previous preview may have been stale).
        try {
          setPreview(await previewClassTimetableGroupShare(classId, semesterId));
        } catch {
          /* keep the current dialog state */
        }
      } else {
        toast.error(
          message === "DOMAIN_NOT_CONFIGURED"
            ? "Set a login domain on the WhatsApp page (Admin → WhatsApp) first."
            : getActionErrorMessage(error, "Could not build the share link.")
        );
      }
    } finally {
      setSharing(false);
    }
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={openDialog}>
        <Users className="size-4" />
        Share to WhatsApp Group
      </Button>

      <Dialog open={dialogOpen} onOpenChange={(open) => !sharing && setDialogOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Share timetable to WhatsApp Group{preview ? ` — ${preview.className}` : ""}
            </DialogTitle>
            <DialogDescription>
              {loading
                ? "Preparing the message…"
                : preview
                  ? `Opens WhatsApp with a pre-filled message for ${preview.className}, ${preview.semesterLabel}. Pick this class's student group there and send it yourself — nothing is sent automatically.`
                  : "Could not load a preview."}
            </DialogDescription>
          </DialogHeader>

          {loading && (
            <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading…
            </div>
          )}

          {!loading && preview && (
            <div className="space-y-3 text-sm">
              {!preview.domainConfigured && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <p>
                    Set a login domain on the WhatsApp page (Admin → WhatsApp) first — the message
                    links there.
                  </p>
                </div>
              )}

              {alreadyShared && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
                  <Check className="mt-0.5 size-4 shrink-0" />
                  <p>
                    This timetable was already shared to a group at{" "}
                    {new Date(preview.lastSharedAt!).toLocaleString()}. Share again only if it
                    didn&rsquo;t go through the first time.
                  </p>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                No phone number is used — WhatsApp shows its own chat/group picker. This app never
                learns which group you choose and sends nothing itself.
              </p>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} disabled={sharing}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleShare}
              disabled={sharing || loading || !preview || !preview.domainConfigured}
            >
              {sharing && <Loader2 className="size-4 animate-spin" />}
              {alreadyShared ? "Share again" : "Open WhatsApp"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
