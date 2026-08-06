"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { Class, Program } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { getActionErrorMessage } from "@/lib/action-error";
import {
  previewBulkClassPeriodUpdate,
  bulkUpdateClassPeriod,
  type BulkPeriodPreviewRow,
} from "./actions";

type ClassWithProgram = Class & { program: Program };

const ALL_PROGRAMS = "all";
const ALL_SEMESTERS = "all";
const SEMESTER_NUMBERS = Array.from({ length: 8 }, (_, i) => i + 1);

const PERIOD_LABELS: Record<"MORNING" | "AFTERNOON", string> = {
  MORNING: "Morning (Subax)",
  AFTERNOON: "Afternoon (Galab)",
};

export function BulkPeriodDialog({
  open,
  onOpenChange,
  classes,
  programs,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  classes: ClassWithProgram[];
  programs: Program[];
}) {
  const router = useRouter();
  const [programFilter, setProgramFilter] = useState(ALL_PROGRAMS);
  const [semesterFilter, setSemesterFilter] = useState(ALL_SEMESTERS);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [step, setStep] = useState<"select" | "confirm">("select");
  const [previewRows, setPreviewRows] = useState<BulkPeriodPreviewRow[]>([]);
  const [newPeriod, setNewPeriod] = useState<"MORNING" | "AFTERNOON" | "">("");
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Period is FT-only — PT classes are excluded from this action entirely
  // (never even offered), same rule as everywhere else Period appears.
  // Only active classes are offered; a deactivated class isn't in normal
  // use, so bulk-changing its period isn't a meaningful action.
  const ftClasses = useMemo(() => classes.filter((c) => c.studyMode === "FT" && !c.deletedAt), [classes]);

  const visibleClasses = useMemo(
    () =>
      ftClasses.filter(
        (c) =>
          (programFilter === ALL_PROGRAMS || c.programId === programFilter) &&
          (semesterFilter === ALL_SEMESTERS || String(c.currentSemesterNumber) === semesterFilter)
      ),
    [ftClasses, programFilter, semesterFilter]
  );

  const selectedIds = useMemo(
    () => Object.entries(checked).filter(([, v]) => v).map(([id]) => id),
    [checked]
  );
  const visibleSelectedCount = visibleClasses.filter((c) => checked[c.id]).length;

  function resetAndClose() {
    setProgramFilter(ALL_PROGRAMS);
    setSemesterFilter(ALL_SEMESTERS);
    setChecked({});
    setStep("select");
    setPreviewRows([]);
    setNewPeriod("");
    onOpenChange(false);
  }

  async function handleContinue() {
    if (selectedIds.length === 0) return;
    setLoadingPreview(true);
    try {
      const rows = await previewBulkClassPeriodUpdate(selectedIds);
      setPreviewRows(rows);
      setStep("confirm");
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not load the selected classes."));
    } finally {
      setLoadingPreview(false);
    }
  }

  async function handleConfirm() {
    if (!newPeriod || previewRows.length === 0) return;
    setSubmitting(true);
    try {
      const result = await bulkUpdateClassPeriod({
        classIds: previewRows.map((r) => r.classId),
        newPeriod,
      });
      toast.success(
        `${result.updated} class${result.updated === 1 ? "" : "es"} updated to ${PERIOD_LABELS[newPeriod]}.`
      );
      router.refresh();
      resetAndClose();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not update the selected classes' period."));
    } finally {
      setSubmitting(false);
    }
  }

  const classesWithExistingSlots = previewRows.filter((r) => r.hasExistingSlots);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : resetAndClose())}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Bulk update period</DialogTitle>
          <DialogDescription>
            {step === "select"
              ? "Change many FT classes' period (Morning/Afternoon) at once, instead of editing each one individually."
              : "Review the selected classes, then pick the period to apply to all of them."}
          </DialogDescription>
        </DialogHeader>

        {step === "select" ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2">
              <div className="w-56">
                <Select
                  value={programFilter}
                  onValueChange={(value) => setProgramFilter(value || ALL_PROGRAMS)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Program" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_PROGRAMS}>All programs</SelectItem>
                    {programs.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="w-48">
                <Select
                  value={semesterFilter}
                  onValueChange={(value) => setSemesterFilter(value || ALL_SEMESTERS)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Semester" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_SEMESTERS}>All semesters</SelectItem>
                    {SEMESTER_NUMBERS.map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        Semester {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="max-h-80 overflow-auto rounded-lg border border-border">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        checked={visibleClasses.length > 0 && visibleSelectedCount === visibleClasses.length}
                        onCheckedChange={(value) =>
                          setChecked((prev) => ({
                            ...prev,
                            ...Object.fromEntries(visibleClasses.map((c) => [c.id, value === true])),
                          }))
                        }
                      />
                    </TableHead>
                    <TableHead>Class</TableHead>
                    <TableHead>Semester</TableHead>
                    <TableHead>Current period</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleClasses.map((c, i) => (
                    <TableRow key={c.id} className={i % 2 === 1 ? "bg-muted/30" : undefined}>
                      <TableCell>
                        <Checkbox
                          checked={checked[c.id] ?? false}
                          onCheckedChange={(value) =>
                            setChecked((prev) => ({ ...prev, [c.id]: value === true }))
                          }
                        />
                      </TableCell>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell>{c.currentSemesterNumber ?? "—"}</TableCell>
                      <TableCell>
                        {c.period ? (
                          PERIOD_LABELS[c.period]
                        ) : (
                          <span className="text-amber-700 dark:text-amber-400">Not set</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {visibleClasses.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground">
                        No FT classes match these filters.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {selectedIds.length} class{selectedIds.length === 1 ? "" : "es"} selected
              </p>
              <Button onClick={handleContinue} disabled={selectedIds.length === 0 || loadingPreview}>
                {loadingPreview && <Loader2 className="size-4 animate-spin" />}
                Continue
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="max-h-64 overflow-auto rounded-lg border border-border">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead>Class</TableHead>
                    <TableHead>Current period</TableHead>
                    <TableHead>Existing timetable?</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {previewRows.map((r, i) => (
                    <TableRow key={r.classId} className={i % 2 === 1 ? "bg-muted/30" : undefined}>
                      <TableCell className="font-medium">{r.className}</TableCell>
                      <TableCell>
                        {r.currentPeriod ? (
                          PERIOD_LABELS[r.currentPeriod]
                        ) : (
                          <span className="text-amber-700 dark:text-amber-400">Not set</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {r.hasExistingSlots ? (
                          <span className="font-medium text-amber-700 dark:text-amber-400">Yes</span>
                        ) : (
                          <span className="text-muted-foreground">No</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {classesWithExistingSlots.length > 0 && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <p>
                  {classesWithExistingSlots.length} of these classes already have a scheduled
                  timetable under their current period — changing period will NOT move existing
                  sessions automatically; you may need to regenerate or manually adjust their
                  timetable after this change.
                </p>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label>New period</Label>
              <Select value={newPeriod} onValueChange={(value) => setNewPeriod(value as "MORNING" | "AFTERNOON")}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a period" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MORNING">Morning (Subax)</SelectItem>
                  <SelectItem value="AFTERNOON">Afternoon (Galab)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between">
              <Button type="button" variant="outline" onClick={() => setStep("select")} disabled={submitting}>
                Back
              </Button>
              <Button onClick={handleConfirm} disabled={!newPeriod || submitting}>
                {submitting && <Loader2 className="size-4 animate-spin" />}
                Confirm — update {previewRows.length} class{previewRows.length === 1 ? "" : "es"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
