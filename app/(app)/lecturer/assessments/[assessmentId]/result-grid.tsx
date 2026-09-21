"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { TableSearchInput } from "@/components/ui/table-search-input";
import { getActionErrorMessage } from "@/lib/action-error";
import { saveResult, correctResult, addLateResult, publishLateResult } from "./actions";

type AttendanceStatus = "PRESENT" | "ABSENT" | "EXEMPT";
type ResultStatus = "DRAFT" | "PUBLISHED";

export interface GridRow {
  enrollmentId: string;
  studentId: string;
  studentName: string;
  studentNo: string;
  groupName: string | null;
  resultId: string | null;
  // null = no result row exists yet for this student on this assessment.
  resultStatus: ResultStatus | null;
  mark: number | null;
  attendanceStatus: AttendanceStatus;
  updatedAt: string | null;
  isCorrected: boolean;
}

const ATTENDANCE_ITEMS = [
  { value: "PRESENT", label: "Present" },
  { value: "ABSENT", label: "Absent" },
  { value: "EXEMPT", label: "Exempt" },
];

export function ResultGrid({
  assessmentId,
  maximumMarks,
  mode,
  readOnly,
  canLateAdd = false,
  initialRows,
  groupId = null,
}: {
  assessmentId: string;
  maximumMarks: number;
  mode: "INDIVIDUAL" | "GROUP";
  readOnly: boolean;
  // True only once the assessment itself is PUBLISHED (never DRAFT or
  // CLOSED) — gates both "Add result" (a student with no result row yet)
  // and "Publish" (a late-added result that's still DRAFT).
  canLateAdd?: boolean;
  initialRows: GridRow[];
  // Reference only (snapshot model) — set when this grid is scoped to a
  // single group's "Different marks" panel, omitted for the plain
  // individual grid and the ungrouped-students section.
  groupId?: string | null;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [markText, setMarkText] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      initialRows.map((r) => [r.enrollmentId, r.mark === null ? "" : String(r.mark)])
    )
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [correcting, setCorrecting] = useState<GridRow | null>(null);
  const [correctionMark, setCorrectionMark] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionSubmitting, setCorrectionSubmitting] = useState(false);
  const [search, setSearch] = useState("");

  const [addingRow, setAddingRow] = useState<GridRow | null>(null);
  const [addMarkText, setAddMarkText] = useState("");
  const [addAttendance, setAddAttendance] = useState<AttendanceStatus>("PRESENT");
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [publishingResultId, setPublishingResultId] = useState<string | null>(null);

  const markRefs = useRef<Array<HTMLInputElement | null>>([]);
  const inFlightRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef<Map<string, AttendanceStatus | undefined>>(
    new Map()
  );

  function updateRow(index: number, patch: Partial<GridRow>) {
    setRows((prev) =>
      prev.map((r, i) => (i === index ? { ...r, ...patch } : r))
    );
  }

  // Enter, Tab, and blur can all fire for the same edit in quick succession.
  // Without this guard, a second save starts before the first's fresh
  // updatedAt comes back, and gets spuriously rejected as a stale write.
  async function saveRow(index: number, overrideAttendance?: AttendanceStatus) {
    const enrollmentId = rows[index].enrollmentId;
    if (inFlightRef.current.has(enrollmentId)) {
      pendingRef.current.set(enrollmentId, overrideAttendance);
      return;
    }
    inFlightRef.current.add(enrollmentId);
    try {
      await performSave(index, overrideAttendance);
    } finally {
      inFlightRef.current.delete(enrollmentId);
      if (pendingRef.current.has(enrollmentId)) {
        const queuedAttendance = pendingRef.current.get(enrollmentId);
        pendingRef.current.delete(enrollmentId);
        await saveRow(index, queuedAttendance);
      }
    }
  }

  async function performSave(index: number, overrideAttendance?: AttendanceStatus) {
    const row = rows[index];
    const attendanceStatus = overrideAttendance ?? row.attendanceStatus;
    setErrors((prev) => ({ ...prev, [row.enrollmentId]: "" }));

    let mark: number | null = null;
    if (attendanceStatus === "PRESENT") {
      const text = (markText[row.enrollmentId] ?? "").trim();
      if (text !== "") {
        const parsed = Number(text);
        if (Number.isNaN(parsed)) {
          setErrors((prev) => ({
            ...prev,
            [row.enrollmentId]: "Enter a valid number",
          }));
          return;
        }
        if (parsed < 0 || parsed > maximumMarks) {
          setErrors((prev) => ({
            ...prev,
            [row.enrollmentId]: `Must be 0–${maximumMarks}`,
          }));
          return;
        }
        mark = parsed;
      }
    }

    setSaving((prev) => ({ ...prev, [row.enrollmentId]: true }));
    try {
      const result = await saveResult(assessmentId, {
        enrollmentId: row.enrollmentId,
        mark,
        attendanceStatus,
        currentUpdatedAt: row.updatedAt,
        groupId,
      });
      updateRow(index, {
        mark,
        attendanceStatus,
        resultId: result.resultId,
        updatedAt: result.updatedAt,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "STALE_WRITE") {
        toast.error(
          "This result was changed elsewhere. Refreshing with the latest data…"
        );
        router.refresh();
        return;
      }
      const message =
        error instanceof Error && error.message === "MARK_OUT_OF_RANGE"
          ? `Must be 0–${maximumMarks}`
          : "Could not save. Try again.";
      setErrors((prev) => ({ ...prev, [row.enrollmentId]: message }));
    } finally {
      setSaving((prev) => ({ ...prev, [row.enrollmentId]: false }));
    }
  }

  async function onAttendanceChange(index: number, status: AttendanceStatus) {
    updateRow(index, { attendanceStatus: status });
    if (status !== "PRESENT") {
      setMarkText((prev) => ({ ...prev, [rows[index].enrollmentId]: "" }));
    }
    // Pass the new status explicitly — saveRow must not rely on the `rows`
    // state update above having landed yet (React hasn't re-rendered at this
    // point), or it would save using the stale pre-change attendance status.
    await saveRow(index, status);
  }

  function focusRow(index: number) {
    markRefs.current[index]?.focus();
    markRefs.current[index]?.select();
  }

  function handleKeyDown(
    e: React.KeyboardEvent<HTMLInputElement>,
    index: number
  ) {
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const goingBack = e.key === "Tab" && e.shiftKey;
      saveRow(index).then(() => {
        focusRow(goingBack ? index - 1 : index + 1);
      });
    }
  }

  function openCorrection(row: GridRow) {
    setCorrecting(row);
    setCorrectionMark(row.mark === null ? "" : String(row.mark));
    setCorrectionReason("");
  }

  async function submitCorrection() {
    if (!correcting?.resultId) return;
    const parsed = Number(correctionMark);
    if (Number.isNaN(parsed) || parsed < 0 || parsed > maximumMarks) {
      toast.error(`Enter a mark between 0 and ${maximumMarks}.`);
      return;
    }
    if (!correctionReason.trim()) {
      toast.error("A reason is required.");
      return;
    }

    setCorrectionSubmitting(true);
    try {
      await correctResult(assessmentId, correcting.resultId, {
        newMark: parsed,
        reason: correctionReason.trim(),
      });
      toast.success("Result corrected.");
      setCorrecting(null);
      router.refresh();
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setCorrectionSubmitting(false);
    }
  }

  // Add result — a NEW draft row for a student who currently has none, on
  // an already-published assessment. Deliberately only ever offered for a
  // row whose resultId is null (see the action cell below), so there's no
  // way to reach this for a student who already has a result.
  function openAddLate(row: GridRow) {
    setAddingRow(row);
    setAddMarkText("");
    setAddAttendance("PRESENT");
  }

  async function submitAddLate() {
    if (!addingRow) return;

    let mark: number | null = null;
    if (addAttendance === "PRESENT") {
      const text = addMarkText.trim();
      if (text !== "") {
        const parsed = Number(text);
        if (Number.isNaN(parsed) || parsed < 0 || parsed > maximumMarks) {
          toast.error(`Enter a mark between 0 and ${maximumMarks}, or leave it blank.`);
          return;
        }
        mark = parsed;
      }
    }

    setAddSubmitting(true);
    try {
      await addLateResult(assessmentId, {
        enrollmentId: addingRow.enrollmentId,
        mark,
        attendanceStatus: addAttendance,
        groupId,
      });
      toast.success(
        `${addingRow.studentName} added as a draft result — publish it when ready.`
      );
      setAddingRow(null);
      router.refresh();
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Could not add this student. Try again.")
      );
    } finally {
      setAddSubmitting(false);
    }
  }

  async function onPublishLate(row: GridRow) {
    if (!row.resultId) return;
    if (
      !window.confirm(
        `Publish ${row.studentName}'s result now? Once published, it becomes visible to the student and can only be changed through the correction flow.`
      )
    ) {
      return;
    }
    setPublishingResultId(row.resultId);
    try {
      await publishLateResult(assessmentId, row.resultId);
      toast.success(`${row.studentName}'s result published.`);
      router.refresh();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not publish. Try again."));
    } finally {
      setPublishingResultId(null);
    }
  }

  const normalizedSearch = search.trim().toLowerCase();
  const visibleRows = useMemo(() => {
    const indexed = rows.map((row, index) => ({ row, index }));
    if (!normalizedSearch) return indexed;
    return indexed.filter(
      ({ row }) =>
        row.studentName.toLowerCase().includes(normalizedSearch) ||
        row.studentNo.toLowerCase().includes(normalizedSearch)
    );
  }, [rows, normalizedSearch]);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card">
      <div className="p-3 pb-0">
        <TableSearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search by student name or ID…"
          className="max-w-sm"
        />
      </div>
      <Table>
        <TableHeader className="sticky top-0 bg-card">
          <TableRow>
            <TableHead>Student</TableHead>
            {mode === "GROUP" && <TableHead>Group</TableHead>}
            <TableHead>Attendance</TableHead>
            <TableHead className="text-right">Mark</TableHead>
            <TableHead className="w-32" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {visibleRows.map(({ row, index }) => {
            // A late-added result still sitting in DRAFT while the
            // assessment overall is PUBLISHED — the only case where a row
            // stays editable even though the rest of the grid is read-only.
            const isLateDraft = canLateAdd && row.resultStatus === "DRAFT";
            const rowEditable = !readOnly || isLateDraft;

            return (
              <TableRow key={row.enrollmentId}>
                <TableCell className="font-medium">
                  {row.studentName}{" "}
                  <span className="text-muted-foreground">
                    ({row.studentNo})
                  </span>
                </TableCell>
                {mode === "GROUP" && (
                  <TableCell>{row.groupName ?? "—"}</TableCell>
                )}
                <TableCell>
                  <Select
                    value={row.attendanceStatus}
                    onValueChange={(value) =>
                      onAttendanceChange(index, value as AttendanceStatus)
                    }
                    disabled={!rowEditable}
                    items={ATTENDANCE_ITEMS}
                  >
                    <SelectTrigger size="sm" className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ATTENDANCE_ITEMS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex items-center gap-2">
                      {row.isCorrected && (
                        <Badge variant="outline">Corrected</Badge>
                      )}
                      {isLateDraft && <Badge variant="draft">Draft</Badge>}
                      <Input
                        ref={(el) => {
                          markRefs.current[index] = el;
                        }}
                        type="text"
                        inputMode="decimal"
                        className="w-24 text-right"
                        disabled={!rowEditable || row.attendanceStatus !== "PRESENT"}
                        value={markText[row.enrollmentId] ?? ""}
                        onChange={(e) =>
                          setMarkText((prev) => ({
                            ...prev,
                            [row.enrollmentId]: e.target.value,
                          }))
                        }
                        onKeyDown={(e) => handleKeyDown(e, index)}
                        onBlur={() => saveRow(index)}
                      />
                    </div>
                    {errors[row.enrollmentId] && (
                      <span className="text-xs text-destructive">
                        {errors[row.enrollmentId]}
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    {readOnly && row.resultStatus === "PUBLISHED" && row.resultId && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openCorrection(row)}
                      >
                        Correct
                      </Button>
                    )}
                    {canLateAdd && row.resultId === null && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openAddLate(row)}
                      >
                        Add result
                      </Button>
                    )}
                    {isLateDraft && (
                      <Button
                        size="sm"
                        onClick={() => onPublishLate(row)}
                        disabled={publishingResultId === row.resultId}
                      >
                        {publishingResultId === row.resultId
                          ? "Publishing…"
                          : "Publish"}
                      </Button>
                    )}
                    {saving[row.enrollmentId] && (
                      <span className="text-xs text-muted-foreground">
                        Saving…
                      </span>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
          {rows.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={mode === "GROUP" ? 5 : 4}
                className="text-center text-muted-foreground"
              >
                No students are actively enrolled in this course, class, and
                semester.
              </TableCell>
            </TableRow>
          )}
          {rows.length > 0 && visibleRows.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={mode === "GROUP" ? 5 : 4}
                className="text-center text-muted-foreground"
              >
                No students match your search.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <Dialog
        open={!!correcting}
        onOpenChange={(open) => !open && setCorrecting(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Correct result</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              {correcting?.studentName} — current mark:{" "}
              {correcting?.mark ?? "—"}
            </p>
            <div className="flex flex-col gap-1">
              <Label htmlFor="correction-mark">New mark</Label>
              <Input
                id="correction-mark"
                type="number"
                step="0.01"
                min="0"
                max={maximumMarks}
                value={correctionMark}
                onChange={(e) => setCorrectionMark(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="correction-reason">Reason (required)</Label>
              <Input
                id="correction-reason"
                value={correctionReason}
                onChange={(e) => setCorrectionReason(e.target.value)}
              />
            </div>
            <Button
              onClick={submitCorrection}
              disabled={correctionSubmitting}
            >
              Save correction
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!addingRow}
        onOpenChange={(open) => !open && setAddingRow(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add student to published results</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              {addingRow?.studentName} ({addingRow?.studentNo}) has no result
              yet for this assessment — e.g. a late enrollment, class
              transfer, or repeater added after this assessment was already
              published. This creates a new DRAFT result for them only;
              every other student&apos;s published mark is untouched. You&apos;ll
              need to publish it separately once you&apos;re ready.
            </p>
            <div className="flex flex-col gap-1">
              <Label htmlFor="add-late-attendance">Attendance</Label>
              <Select
                value={addAttendance}
                onValueChange={(value) => {
                  const status = value as AttendanceStatus;
                  setAddAttendance(status);
                  if (status !== "PRESENT") setAddMarkText("");
                }}
                items={ATTENDANCE_ITEMS}
              >
                <SelectTrigger id="add-late-attendance">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ATTENDANCE_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="add-late-mark">Mark</Label>
              <Input
                id="add-late-mark"
                type="text"
                inputMode="decimal"
                placeholder="Leave blank to enter later"
                disabled={addAttendance !== "PRESENT"}
                value={addMarkText}
                onChange={(e) => setAddMarkText(e.target.value)}
              />
            </div>
            <Button onClick={submitAddLate} disabled={addSubmitting}>
              {addSubmitting ? "Adding…" : "Add as draft"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
