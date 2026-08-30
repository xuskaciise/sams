"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getActionErrorMessage } from "@/lib/action-error";
import {
  previewMoveSemesterPlan,
  moveSemesterPlan,
  type MoveSemesterPlanPreview,
} from "./actions";

const SEMESTER_NUMBERS = Array.from({ length: 8 }, (_, i) => i + 1);

export function MoveSemesterDialog({
  open,
  onOpenChange,
  classId,
  className,
  defaultSourceSemesterNumber,
  onMoved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  classId: string;
  className: string;
  defaultSourceSemesterNumber: number;
  onMoved: (targetSemesterNumber: number) => void;
}) {
  const router = useRouter();
  const [sourceSem, setSourceSem] = useState<number>(defaultSourceSemesterNumber);
  const [targetSem, setTargetSem] = useState<number | null>(null);
  const [preview, setPreview] = useState<MoveSemesterPlanPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setSourceSem(defaultSourceSemesterNumber);
    setTargetSem(null);
    setPreview(null);
    setLoadingPreview(false);
    setSubmitting(false);
  }

  const loadPreview = useCallback(
    async (source: number, target: number, signal: { cancelled: boolean }) => {
      setLoadingPreview(true);
      try {
        const result = await previewMoveSemesterPlan({
          classId,
          sourceSemesterNumber: source,
          targetSemesterNumber: target,
        });
        if (!signal.cancelled) setPreview(result);
      } catch (error) {
        if (!signal.cancelled) {
          setPreview(null);
          toast.error(
            getActionErrorMessage(error, "Could not load the course plan.")
          );
        }
      } finally {
        if (!signal.cancelled) setLoadingPreview(false);
      }
    },
    [classId]
  );

  // Re-preview whenever the dialog is open and both levels are chosen and
  // differ. `cancelled` guards against a slow response landing after the
  // admin has already changed a picker. Stale preview is cleared in the
  // picker handlers below (events, not this effect) and on close via
  // reset(), so nothing is set synchronously in the effect body.
  useEffect(() => {
    if (!open || targetSem === null || sourceSem === targetSem) return;
    const signal = { cancelled: false };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loadPreview toggles loading state for the newly-selected level pair, same pattern as auto-timetable-generator-client.tsx's void handlePreview()
    loadPreview(sourceSem, targetSem, signal);
    return () => {
      signal.cancelled = true;
    };
  }, [open, sourceSem, targetSem, loadPreview]);

  function onSourceChange(value: string | null) {
    if (!value) return;
    setSourceSem(Number(value));
    setTargetSem(null);
    setPreview(null);
  }

  function onTargetChange(value: string | null) {
    if (!value) return;
    setTargetSem(Number(value));
    setPreview(null);
  }

  async function handleConfirm() {
    if (targetSem === null || !preview) return;
    setSubmitting(true);
    try {
      const { moved, skippedDuplicates } = await moveSemesterPlan({
        classId,
        sourceSemesterNumber: sourceSem,
        targetSemesterNumber: targetSem,
      });
      toast.success(
        `Moved ${moved} course${moved === 1 ? "" : "s"} to Semester ${targetSem}` +
          (skippedDuplicates > 0
            ? ` — ${skippedDuplicates} duplicate${
                skippedDuplicates === 1 ? "" : "s"
              } already there ${skippedDuplicates === 1 ? "was" : "were"} skipped.`
            : ".")
      );
      const target = targetSem;
      reset();
      onOpenChange(false);
      onMoved(target);
      router.refresh();
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Could not move the course plan.")
      );
    } finally {
      setSubmitting(false);
    }
  }

  const sourceEmpty = preview !== null && preview.sourceCourses.length === 0;
  const canConfirm =
    !submitting &&
    !loadingPreview &&
    targetSem !== null &&
    sourceSem !== targetSem &&
    preview !== null &&
    !sourceEmpty;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Move semester</DialogTitle>
          <DialogDescription>
            Move every course planned for {className || "this class"} at one
            semester level to a different one, in one action. Courses already
            planned at the target level are skipped.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>From semester</Label>
              <Select value={String(sourceSem)} onValueChange={onSourceChange}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="Semester" />
                </SelectTrigger>
                <SelectContent>
                  {SEMESTER_NUMBERS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      Semester {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>To semester</Label>
              <Select
                value={targetSem === null ? "" : String(targetSem)}
                onValueChange={onTargetChange}
              >
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="Select a level" />
                </SelectTrigger>
                <SelectContent>
                  {SEMESTER_NUMBERS.filter((n) => n !== sourceSem).map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      Semester {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {loadingPreview && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Checking the plan…
            </p>
          )}

          {preview !== null && !loadingPreview && (
            <>
              <div className="rounded-lg border border-border p-3">
                <p className="mb-2 text-sm font-medium">
                  {preview.sourceCourses.length} course
                  {preview.sourceCourses.length === 1 ? "" : "s"} planned at
                  Semester {sourceSem}
                </p>
                {preview.sourceCourses.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing to move — Semester {sourceSem} has no planned
                    courses for this class.
                  </p>
                ) : (
                  <ul className="list-disc pl-5 text-sm text-muted-foreground">
                    {preview.sourceCourses.map((c) => (
                      <li key={c.id}>{c.name}</li>
                    ))}
                  </ul>
                )}
              </div>

              {targetSem !== null && preview.sourceCourses.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  Semester {targetSem} currently has {preview.targetCourseCount}{" "}
                  course{preview.targetCourseCount === 1 ? "" : "s"}.{" "}
                  {preview.duplicateCourseNames.length > 0 ? (
                    <>
                      {preview.movingCount} will move;{" "}
                      {preview.duplicateCourseNames.length} already there (
                      {preview.duplicateCourseNames.join(", ")}) will be
                      skipped.
                    </>
                  ) : (
                    <>
                      All {preview.movingCount} will be added alongside them.
                    </>
                  )}
                </p>
              )}

              {preview.assignmentCount > 0 && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <p>
                    {preview.assignmentCount} existing assignment
                    {preview.assignmentCount === 1 ? "" : "s"} reference
                    {preview.assignmentCount === 1 ? "s" : ""} these courses at
                    Semester {sourceSem}
                    {preview.timetableSlotCount > 0 && (
                      <>
                        {" "}
                        ({preview.timetableSlotCount} scheduled timetable session
                        {preview.timetableSlotCount === 1 ? "" : "s"} too)
                      </>
                    )}
                    . Moving the plan won&apos;t change those assignments
                    automatically — review them separately.
                  </p>
                </div>
              )}
            </>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button onClick={handleConfirm} disabled={!canConfirm}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              {targetSem === null
                ? "Move semester"
                : `Move Semester ${sourceSem} → Semester ${targetSem}`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
