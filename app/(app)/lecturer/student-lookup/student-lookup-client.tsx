"use client";

import { useState } from "react";
import Link from "next/link";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getActionErrorMessage } from "@/lib/action-error";
// The SAME Server Actions the per-assessment Marks Entry Grid uses — this
// page is only a different entry point (by student instead of by
// assessment); every rule is enforced inside these actions.
import {
  saveResult,
  addLateResult,
  publishLateResult,
  correctResult,
} from "../assessments/[assessmentId]/actions";
import { lookupStudentResults } from "./actions";
import type { StudentLookupResult, StudentLookupRow } from "./queries";

type AttendanceStatus = "PRESENT" | "ABSENT" | "EXEMPT";

const ATTENDANCE_ITEMS = [
  { value: "PRESENT", label: "Present" },
  { value: "ABSENT", label: "Absent" },
  { value: "EXEMPT", label: "Exempt" },
];

function rowKey(row: StudentLookupRow) {
  return `${row.assessmentId}:${row.enrollmentId}`;
}

function formatMark(row: StudentLookupRow): string {
  if (row.attendanceStatus !== "PRESENT") {
    return row.attendanceStatus === "ABSENT" ? "Absent" : "Exempt";
  }
  return row.mark === null ? "—" : String(row.mark);
}

// Parses a mark exactly like the Marks Entry Grid: blank = no mark yet,
// otherwise a number within 0..max. Returns an error string on failure.
function parseMark(
  text: string,
  attendance: AttendanceStatus,
  max: number
): { mark: number | null } | { error: string } {
  if (attendance !== "PRESENT") return { mark: null };
  const trimmed = text.trim();
  if (trimmed === "") return { mark: null };
  const parsed = Number(trimmed);
  if (Number.isNaN(parsed)) return { error: "Enter a valid number" };
  if (parsed < 0 || parsed > max) return { error: `Must be 0–${max}` };
  return { mark: parsed };
}

export function StudentLookupClient({
  canCorrect,
  canPublish,
}: {
  canCorrect: boolean;
  canPublish: boolean;
}) {
  const [studentNo, setStudentNo] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<StudentLookupResult | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Inline-edit state, keyed by assessmentId:enrollmentId.
  const [markText, setMarkText] = useState<Record<string, string>>({});
  const [attendance, setAttendance] = useState<Record<string, AttendanceStatus>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const [lateRow, setLateRow] = useState<StudentLookupRow | null>(null);
  const [lateMark, setLateMark] = useState("");
  const [lateAttendance, setLateAttendance] = useState<AttendanceStatus>("PRESENT");
  const [lateSubmitting, setLateSubmitting] = useState(false);

  const [correctRow, setCorrectRow] = useState<StudentLookupRow | null>(null);
  const [correctMark, setCorrectMark] = useState("");
  const [correctReason, setCorrectReason] = useState("");
  const [correctSubmitting, setCorrectSubmitting] = useState(false);

  function seedEditState(result: StudentLookupResult | null) {
    const marks: Record<string, string> = {};
    const att: Record<string, AttendanceStatus> = {};
    for (const row of result?.rows ?? []) {
      marks[rowKey(row)] = row.mark === null ? "" : String(row.mark);
      att[rowKey(row)] = row.attendanceStatus;
    }
    setMarkText(marks);
    setAttendance(att);
    setErrors({});
  }

  async function runLookup(no: string) {
    if (!no.trim()) return;
    setLoading(true);
    try {
      const result = await lookupStudentResults(no.trim());
      setData(result);
      setNotFound(result === null);
      seedEditState(result);
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not look up this student."));
    } finally {
      setLoading(false);
    }
  }

  // Re-fetch after every write so each row's status/action is recomputed
  // from the DB (e.g. "No result" -> "Draft: 7" after an entry).
  async function refresh() {
    if (data) await runLookup(data.student.studentNo);
  }

  async function saveInline(row: StudentLookupRow) {
    const key = rowKey(row);
    const att = attendance[key] ?? row.attendanceStatus;
    const parsed = parseMark(markText[key] ?? "", att, row.maximumMarks);
    if ("error" in parsed) {
      setErrors((prev) => ({ ...prev, [key]: parsed.error }));
      return;
    }
    setErrors((prev) => ({ ...prev, [key]: "" }));
    setBusy((prev) => ({ ...prev, [key]: true }));
    try {
      await saveResult(row.assessmentId, {
        enrollmentId: row.enrollmentId,
        mark: parsed.mark,
        attendanceStatus: att,
        currentUpdatedAt: row.updatedAt,
        groupId: row.groupId,
      });
      toast.success(`Saved ${row.title}.`);
      await refresh();
    } catch (error) {
      if (error instanceof Error && error.message === "STALE_WRITE") {
        toast.error("This result was changed elsewhere. Reloading the latest data…");
        await refresh();
        return;
      }
      const message =
        error instanceof Error && error.message === "MARK_OUT_OF_RANGE"
          ? `Must be 0–${row.maximumMarks}`
          : error instanceof Error && error.message === "NOT_EDITABLE"
            ? "No longer editable — reload to see its current status."
            : getActionErrorMessage(error, "Could not save. Try again.");
      setErrors((prev) => ({ ...prev, [key]: message }));
    } finally {
      setBusy((prev) => ({ ...prev, [key]: false }));
    }
  }

  async function submitLateAdd() {
    if (!lateRow) return;
    const parsed = parseMark(lateMark, lateAttendance, lateRow.maximumMarks);
    if ("error" in parsed) {
      toast.error(parsed.error);
      return;
    }
    setLateSubmitting(true);
    try {
      await addLateResult(lateRow.assessmentId, {
        enrollmentId: lateRow.enrollmentId,
        mark: parsed.mark,
        attendanceStatus: lateAttendance,
        groupId: lateRow.groupId,
      });
      toast.success("Added as a draft result — publish it when ready.");
      setLateRow(null);
      await refresh();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not add this result. Try again."));
    } finally {
      setLateSubmitting(false);
    }
  }

  async function publishLate(row: StudentLookupRow) {
    if (!row.resultId) return;
    if (
      !window.confirm(
        `Publish this result for "${row.title}" now? Once published, it becomes visible to the student and can only be changed through the correction flow.`
      )
    ) {
      return;
    }
    const key = rowKey(row);
    setBusy((prev) => ({ ...prev, [key]: true }));
    try {
      await publishLateResult(row.assessmentId, row.resultId);
      toast.success("Result published.");
      await refresh();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not publish. Try again."));
    } finally {
      setBusy((prev) => ({ ...prev, [key]: false }));
    }
  }

  async function submitCorrection() {
    if (!correctRow?.resultId) return;
    const parsed = Number(correctMark);
    if (correctMark.trim() === "" || Number.isNaN(parsed) || parsed < 0 || parsed > correctRow.maximumMarks) {
      toast.error(`Enter a mark between 0 and ${correctRow.maximumMarks}.`);
      return;
    }
    if (!correctReason.trim()) {
      toast.error("A reason is required.");
      return;
    }
    setCorrectSubmitting(true);
    try {
      await correctResult(correctRow.assessmentId, correctRow.resultId, {
        newMark: parsed,
        reason: correctReason.trim(),
      });
      toast.success("Result corrected.");
      setCorrectRow(null);
      await refresh();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not correct. Try again."));
    } finally {
      setCorrectSubmitting(false);
    }
  }

  function statusCell(row: StudentLookupRow) {
    if (row.resultStatus === null) {
      return <span className="text-muted-foreground">No result</span>;
    }
    return (
      <div className="flex items-center gap-2">
        <Badge variant={row.resultStatus === "PUBLISHED" ? "published" : "draft"}>
          {row.resultStatus === "PUBLISHED" ? "Published" : "Draft"}
        </Badge>
        <span>{formatMark(row)}</span>
        {row.isCorrected && <Badge variant="outline">Corrected</Badge>}
      </div>
    );
  }

  function inlineEditor(row: StudentLookupRow, extra?: React.ReactNode) {
    const key = rowKey(row);
    const att = attendance[key] ?? row.attendanceStatus;
    return (
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={att}
            onValueChange={(value) => {
              const status = value as AttendanceStatus;
              setAttendance((prev) => ({ ...prev, [key]: status }));
              if (status !== "PRESENT") setMarkText((prev) => ({ ...prev, [key]: "" }));
            }}
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
          <Input
            type="text"
            inputMode="decimal"
            className="w-20 text-right"
            placeholder={`/${row.maximumMarks}`}
            disabled={att !== "PRESENT"}
            value={markText[key] ?? ""}
            onChange={(e) => setMarkText((prev) => ({ ...prev, [key]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void saveInline(row);
              }
            }}
          />
          <Button size="sm" variant="outline" disabled={busy[key]} onClick={() => saveInline(row)}>
            {busy[key] ? "Saving…" : "Save"}
          </Button>
          {extra}
        </div>
        {errors[key] && <span className="text-xs text-destructive">{errors[key]}</span>}
      </div>
    );
  }

  function actionCell(row: StudentLookupRow) {
    const key = rowKey(row);
    const action = row.action;
    switch (action.kind) {
      case "ENTER":
        return inlineEditor(row);
      case "EDIT_DRAFT":
        return inlineEditor(
          row,
          action.canPublish && canPublish ? (
            <Button size="sm" disabled={busy[key]} onClick={() => publishLate(row)}>
              Publish
            </Button>
          ) : null
        );
      case "LATE_ADD":
        return (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setLateRow(row);
              setLateMark("");
              setLateAttendance("PRESENT");
            }}
          >
            Add late result
          </Button>
        );
      case "CORRECT":
        return canCorrect ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setCorrectRow(row);
              setCorrectMark(row.mark === null ? "" : String(row.mark));
              setCorrectReason("");
            }}
          >
            Correct
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">Published — no correction access</span>
        );
      case "READ_ONLY":
        return <span className="text-xs text-muted-foreground">{action.reason}</span>;
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="lookup-student-no">Student ID</Label>
          <Input
            id="lookup-student-no"
            placeholder="e.g. CMS2601"
            value={studentNo}
            onChange={(e) => setStudentNo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void runLookup(studentNo);
              }
            }}
          />
        </div>
        <Button onClick={() => runLookup(studentNo)} disabled={loading || !studentNo.trim()}>
          {loading ? "Looking up…" : "Look up"}
        </Button>
      </div>

      {notFound && (
        <div className="rounded-lg border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
          No results found for this student in your courses.
        </div>
      )}

      {data && (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-card">
          <div className="p-3 pb-0 text-sm">
            <span className="font-semibold">{data.student.fullName}</span>{" "}
            <span className="text-muted-foreground">({data.student.studentNo})</span>
            <span className="text-muted-foreground"> — {data.rows.length} assessment(s) in your courses</span>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Course</TableHead>
                  <TableHead>Assessment</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Max</TableHead>
                  <TableHead>Current status</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((row) => (
                  <TableRow key={rowKey(row)}>
                    <TableCell>
                      <div className="font-medium">{row.courseName}</div>
                      <div className="text-xs text-muted-foreground">
                        {row.classLabel} · {row.semesterLabel}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/lecturer/assessments/${row.assessmentId}`}
                        className="font-medium hover:underline"
                      >
                        {row.title}
                      </Link>
                      {row.assessmentStatus !== "PUBLISHED" && (
                        <div className="text-xs text-muted-foreground">
                          Assessment {row.assessmentStatus.toLowerCase()}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>{row.typeName}</TableCell>
                    <TableCell className="text-right">{row.maximumMarks}</TableCell>
                    <TableCell>{statusCell(row)}</TableCell>
                    <TableCell>{actionCell(row)}</TableCell>
                  </TableRow>
                ))}
                {data.rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      This student is enrolled in your courses, but no assessments have been created yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <Dialog open={!!lateRow} onOpenChange={(open) => !open && setLateRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add late result</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              &ldquo;{lateRow?.title}&rdquo; is already published and {data?.student.fullName} has
              no result for it. This creates a new DRAFT result for this student only — every other
              student&apos;s published mark is untouched. Publish it separately when ready.
            </p>
            <div className="flex flex-col gap-1">
              <Label htmlFor="late-attendance">Attendance</Label>
              <Select
                value={lateAttendance}
                onValueChange={(value) => {
                  const status = value as AttendanceStatus;
                  setLateAttendance(status);
                  if (status !== "PRESENT") setLateMark("");
                }}
                items={ATTENDANCE_ITEMS}
              >
                <SelectTrigger id="late-attendance">
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
              <Label htmlFor="late-mark">Mark (max {lateRow?.maximumMarks})</Label>
              <Input
                id="late-mark"
                type="text"
                inputMode="decimal"
                placeholder="Leave blank to enter later"
                disabled={lateAttendance !== "PRESENT"}
                value={lateMark}
                onChange={(e) => setLateMark(e.target.value)}
              />
            </div>
            <Button onClick={submitLateAdd} disabled={lateSubmitting}>
              {lateSubmitting ? "Adding…" : "Add as draft"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!correctRow} onOpenChange={(open) => !open && setCorrectRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Correct result</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              {correctRow?.title} — current mark: {correctRow ? formatMark(correctRow) : "—"}. The
              correction is recorded permanently with your reason.
            </p>
            <div className="flex flex-col gap-1">
              <Label htmlFor="correct-mark">New mark (max {correctRow?.maximumMarks})</Label>
              <Input
                id="correct-mark"
                type="number"
                step="0.01"
                min="0"
                max={correctRow?.maximumMarks}
                value={correctMark}
                onChange={(e) => setCorrectMark(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="correct-reason">Reason (required)</Label>
              <Input
                id="correct-reason"
                value={correctReason}
                onChange={(e) => setCorrectReason(e.target.value)}
              />
            </div>
            <Button onClick={submitCorrection} disabled={correctSubmitting}>
              {correctSubmitting ? "Saving…" : "Save correction"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
