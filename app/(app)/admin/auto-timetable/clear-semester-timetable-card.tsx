"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
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
import { previewClearSemesterTimetable, clearSemesterLevelTimetable, type ClearSemesterPreview } from "./actions";
import type { WorkloadImportSemesterOption } from "../workload-import/semester-workload-import-client";

interface Props {
  semesterNumberOptions: WorkloadImportSemesterOption[];
}

// Batch-level counterpart to the Timetable Builder's per-class "Clear
// timetable" action (admin/timetable/build-timetable-client.tsx) — wipes
// every TimetableSlot for every class at one Class.currentSemesterNumber
// level in the active Semester, so a previously generated/manual
// timetable can be cleared before re-generating. Lives on the
// workload-import/auto-generate screen (gated on timetable.generate,
// same key that gates auto-generation itself) rather than Academic
// Calendar, since "semesterNumber level" is this page's own batching
// concept, not the real Semester lifecycle Academic Calendar manages.
// Only ever deletes TimetableSlot rows — LecturerCourseAssignment/
// creditHours (the workload-import data) is never touched, so the
// persistent "N assignment(s) not yet scheduled" card picks these back up
// automatically once this clears their slots (see
// admin/auto-timetable/actions.ts's clearSemesterLevelTimetable).
export function ClearSemesterTimetableCard({ semesterNumberOptions }: Props) {
  const router = useRouter();
  const [level, setLevel] = useState<number | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [preview, setPreview] = useState<ClearSemesterPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [clearing, setClearing] = useState(false);

  if (semesterNumberOptions.length === 0) return null;

  async function openDialog() {
    if (level === null) return;
    setDialogOpen(true);
    setPreview(null);
    setLoadingPreview(true);
    try {
      const result = await previewClearSemesterTimetable(level);
      setPreview(result);
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not check this semester level's current timetable."));
      setDialogOpen(false);
    } finally {
      setLoadingPreview(false);
    }
  }

  async function handleClear() {
    if (level === null) return;
    setClearing(true);
    try {
      const result = await clearSemesterLevelTimetable(level);
      toast.success(
        `${result.deleted} session${result.deleted === 1 ? "" : "s"} removed across ${result.classCount} class${
          result.classCount === 1 ? "" : "es"
        }.`
      );
      setDialogOpen(false);
      setPreview(null);
      router.refresh();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not clear this semester level's timetable."));
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <Trash2 className="mt-0.5 size-5 text-muted-foreground" />
        <div className="text-sm">
          <p className="font-semibold">Clear timetable for a semester level</p>
          <p className="text-muted-foreground">
            Deletes every scheduled session for every class at a semester level, in the active
            semester — course assignments and credit hours stay intact, so you can re-generate
            without re-importing the Excel.
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
        <Button type="button" variant="outline" className="text-destructive hover:text-destructive" onClick={openDialog} disabled={level === null}>
          Clear timetable
        </Button>
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => !clearing && setDialogOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear timetable for semester level {level}?</DialogTitle>
            <DialogDescription>
              {loadingPreview
                ? "Checking the current timetable for this semester level…"
                : preview
                  ? `This will delete ${preview.totalCount} scheduled session${preview.totalCount === 1 ? "" : "s"} across ${preview.classes.length} class${preview.classes.length === 1 ? "" : "es"} in ${preview.semesterLabel}. This cannot be undone.`
                  : "Could not load a preview for this semester level."}
            </DialogDescription>
          </DialogHeader>

          {loadingPreview && (
            <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading…
            </div>
          )}

          {!loadingPreview && preview && preview.totalCount === 0 && (
            <p className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
              No scheduled sessions exist yet for this semester level — nothing to clear.
            </p>
          )}

          {!loadingPreview && preview && preview.classes.length > 0 && (
            <>
              <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <p>
                  Only the scheduled sessions are removed — course assignments and credit hours stay
                  intact, so you can re-generate without re-uploading a workload Excel.
                </p>
              </div>
              <div className="max-h-48 overflow-auto rounded-lg border border-border">
                <ul className="divide-y divide-border text-sm">
                  {preview.classes.map((c) => (
                    <li key={c.classId} className="flex items-center justify-between px-3 py-1.5">
                      <span>{c.className}</span>
                      <span className="text-muted-foreground">
                        {c.count} session{c.count === 1 ? "" : "s"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} disabled={clearing}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleClear}
              disabled={clearing || loadingPreview || !preview || preview.totalCount === 0}
            >
              {clearing && <Loader2 className="size-4 animate-spin" />}
              Yes, clear this timetable
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
