"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Save, Pencil, Trash2, Search } from "lucide-react";
import type { MissedExamType, MissedExamReasonType, EnrollmentStatus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { PageHeader } from "@/components/layout/page-header";
import { TableSearchInput } from "@/components/ui/table-search-input";
import { TablePagination } from "@/components/ui/table-pagination";
import { formatClassLabel } from "@/lib/class-label";
import { getActionErrorMessage } from "@/lib/action-error";
import { useUrlTableState } from "@/lib/use-url-table-state";
import type { ExamPeriodOption, MissedExamGridRow } from "./queries";
import type { StudentLookupData } from "./actions";
import {
  lookupStudentForMissedExam,
  recordMissedExamsBulk,
  updateMissedExamRecord,
  deleteMissedExamRecord,
} from "./actions";

interface RecordRow {
  id: string;
  examType: MissedExamType;
  reasonType: MissedExamReasonType;
  reasonNote: string | null;
  recordedAt: Date;
  student: { studentNo: string; fullName: string };
  enrollment: {
    course: { name: string; code: string };
    class: { name: string; currentSemesterNumber: number | null };
  };
  specialExamPeriod: { name: string };
  recordedBy: { fullName: string };
}

const EXAM_TYPE_ITEMS = [
  { value: "all", label: "All exam types" },
  { value: "MIDTERM", label: "Midterm" },
  { value: "FINAL", label: "Final" },
  { value: "BOTH", label: "Both" },
];

// Reason Type is a small, fixed 4-value list — same shape as everywhere
// else in this app — but rendered via SearchableSelect (not a plain
// Select) per an explicit visual/UX-consistency request, reused
// identically wherever Reason Type appears in this module (the filter
// bar below, the bulk grid's per-row picker, and the edit dialog).
const REASON_TYPE_OPTIONS = [
  { value: "ILLNESS", label: "Illness" },
  { value: "CHEATING", label: "Cheating" },
  { value: "EMERGENCY", label: "Emergency" },
  { value: "OTHER", label: "Other" },
];
const REASON_TYPE_FILTER_ITEMS = [
  { value: "", label: "All reasons" },
  ...REASON_TYPE_OPTIONS,
];

const EXAM_TYPE_LABEL: Record<MissedExamType, string> = {
  MIDTERM: "Midterm",
  FINAL: "Final",
  BOTH: "Both",
};

const REASON_BADGE: Record<
  MissedExamReasonType,
  { label: string; variant: "destructive" | "draft" | "secondary" | "outline" }
> = {
  ILLNESS: { label: "Illness", variant: "draft" },
  CHEATING: { label: "Cheating", variant: "destructive" },
  EMERGENCY: { label: "Emergency", variant: "secondary" },
  OTHER: { label: "Other", variant: "outline" },
};

// Same status/color convention as admin/enrollments/enrollments-client.tsx's
// own STATUS_VARIANT — reused, not reinvented.
const STATUS_VARIANT: Record<EnrollmentStatus, "published" | "outline" | "draft" | "secondary"> = {
  ACTIVE: "published",
  COMPLETED: "secondary",
  TRANSFERRED: "outline",
  DROPPED: "outline",
};

function studentLabel(student: { studentNo: string; fullName: string }): string {
  return `${student.studentNo} — ${student.fullName}`;
}

interface RowState {
  midterm: boolean;
  final: boolean;
  reasonType: MissedExamReasonType;
  reasonNote: string;
}

function defaultRowState(): RowState {
  return { midterm: false, final: false, reasonType: "ILLNESS", reasonNote: "" };
}

interface LevelGroup {
  level: number | null;
  rows: MissedExamGridRow[];
}

// Groups a student's full enrollment history by the batch's cycle level
// (1..8, resolved per-enrollment via ClassCoursePlan — see
// getStudentEnrollmentRows's own doc comment for why Class.
// currentSemesterNumber alone can't be used here) — ascending, with an
// "Unspecified level" bucket (enrollments with no matching ClassCoursePlan
// row) always last, never dropped.
function groupByLevel(rows: MissedExamGridRow[]): LevelGroup[] {
  const byLevel = new Map<number | null, MissedExamGridRow[]>();
  for (const r of rows) {
    const list = byLevel.get(r.level) ?? [];
    list.push(r);
    byLevel.set(r.level, list);
  }
  const numericLevels = [...byLevel.keys()]
    .filter((k): k is number => k !== null)
    .sort((a, b) => a - b);
  const groups: LevelGroup[] = numericLevels.map((level) => ({
    level,
    rows: byLevel.get(level)!,
  }));
  if (byLevel.has(null)) {
    groups.push({ level: null, rows: byLevel.get(null)! });
  }
  return groups;
}

function BulkRegistrationSection({ periods }: { periods: ExamPeriodOption[] }) {
  const router = useRouter();
  const [periodId, setPeriodId] = useState("");
  const [studentNoInput, setStudentNoInput] = useState("");
  const [looking, setLooking] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookup, setLookup] = useState<StudentLookupData | null>(null);
  const [rowState, setRowState] = useState<Map<string, RowState>>(new Map());
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleLookup() {
    const trimmed = studentNoInput.trim();
    if (!trimmed || !periodId) return;
    setLooking(true);
    setLookupError(null);
    try {
      const result = await lookupStudentForMissedExam(periodId, trimmed);
      if (!result) {
        setLookup(null);
        setLookupError(
          "No student found with that ID (or they're outside your faculty)."
        );
      } else {
        setLookup(result);
        setRowState(new Map());
      }
    } catch (error) {
      setLookup(null);
      setLookupError(getActionErrorMessage(error, "Could not look up that student."));
    } finally {
      setLooking(false);
    }
  }

  // Picking a different period invalidates whatever grid was already
  // built — it was filtered to the PREVIOUS period's own semester parity,
  // which may no longer apply. Force a fresh Look up rather than silently
  // showing a stale/wrong-parity grid under the new period.
  function selectPeriod(id: string) {
    setPeriodId(id);
    setLookup(null);
    setLookupError(null);
    setRowState(new Map());
  }

  const visibleRows = useMemo(() => {
    const rows = lookup?.rows ?? [];
    if (!search.trim()) return rows;
    const q = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        r.courseName.toLowerCase().includes(q) ||
        r.courseCode.toLowerCase().includes(q) ||
        r.className.toLowerCase().includes(q)
    );
  }, [lookup, search]);

  const groups = useMemo(() => groupByLevel(visibleRows), [visibleRows]);

  function getState(enrollmentId: string): RowState {
    return rowState.get(enrollmentId) ?? defaultRowState();
  }

  function updateRow(enrollmentId: string, patch: Partial<RowState>) {
    setRowState((prev) => {
      const next = new Map(prev);
      next.set(enrollmentId, { ...getState(enrollmentId), ...patch });
      return next;
    });
  }

  const checkedCount = (lookup?.rows ?? []).filter((r) => {
    const s = rowState.get(r.enrollmentId);
    return s && (s.midterm || s.final);
  }).length;

  async function handleSave() {
    if (!periodId || !lookup) return;
    const submitRows = lookup.rows
      .map((r) => {
        const s = rowState.get(r.enrollmentId);
        if (!s || (!s.midterm && !s.final)) return null;
        const examType: MissedExamType =
          s.midterm && s.final ? "BOTH" : s.midterm ? "MIDTERM" : "FINAL";
        return {
          enrollmentId: r.enrollmentId,
          examType,
          reasonType: s.reasonType,
          reasonNote: s.reasonNote || undefined,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (submitRows.length === 0) {
      toast.error("Check at least one Midterm/Final/All box before saving.");
      return;
    }

    setSaving(true);
    try {
      const result = await recordMissedExamsBulk({
        specialExamPeriodId: periodId,
        studentId: lookup.student.id,
        rows: submitRows,
      });
      toast.success(
        `${result.created} missed exam(s) recorded${
          result.skipped > 0 ? `, ${result.skipped} skipped` : ""
        }.`
      );
      setRowState(new Map());
      router.refresh();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not save. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  if (periods.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No Special Exam Period set up yet</CardTitle>
          <CardDescription>
            Create a Special Exam Period first, then come back here to
            register students against it.
          </CardDescription>
        </CardHeader>
        <div className="px-6 pb-6">
          <Button nativeButton={false} render={<Link href="/admin/exam-periods" />}>
            Go to Special Exam Periods
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-64">
          <label className="mb-1 block text-sm font-medium">Special Exam Period</label>
          <Select value={periodId} onValueChange={(value) => selectPeriod(value ?? "")}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a period" />
            </SelectTrigger>
            <SelectContent>
              {periods.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-64">
          <label className="mb-1 block text-sm font-medium">Student ID</label>
          <div className="flex gap-2">
            <Input
              value={studentNoInput}
              onChange={(e) => setStudentNoInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleLookup();
                }
              }}
              placeholder="e.g. S1001"
              disabled={!periodId}
            />
            <Button onClick={handleLookup} disabled={!periodId || !studentNoInput.trim() || looking}>
              {looking ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Search className="size-4" />
              )}
              Look up
            </Button>
          </div>
        </div>
      </div>

      {!periodId && (
        <p className="text-sm text-muted-foreground">
          Pick a Special Exam Period above before looking a student up.
        </p>
      )}
      {lookupError && <p className="text-sm text-destructive">{lookupError}</p>}

      {lookup && (
        <>
          <p className="text-sm">
            <span className="font-semibold">{studentLabel(lookup.student)}</span>
            {" — "}
            {lookup.rows.length} enrollment{lookup.rows.length === 1 ? "" : "s"} found
            matching {lookup.periodName}&rsquo;s semester levels.
          </p>
          {lookup.parity !== null && lookup.totalEnrollments > lookup.rows.length && (
            <p className="text-sm text-muted-foreground">
              {lookup.totalEnrollments - lookup.rows.length} other enrollment
              {lookup.totalEnrollments - lookup.rows.length === 1 ? "" : "s"} at{" "}
              {lookup.parity === "ODD" ? "even" : "odd"}-numbered (or unspecified) semester
              levels are hidden — they do not match this period&rsquo;s Semester{" "}
              {lookup.parity === "ODD" ? 1 : 2} scope.
            </p>
          )}
          {lookup.parity === null && (
            <p className="text-sm text-amber-600">
              This period&rsquo;s semester has no semester number set, so every enrollment
              level is shown unfiltered.
            </p>
          )}

          {lookup.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No courses found for {studentLabel(lookup.student)} in {lookup.periodName}
              &rsquo;s semester levels.
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <TableSearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder="Search by course or class…"
                  className="w-full sm:w-72"
                />
                <div className="flex items-center gap-3">
                  <span className="text-sm text-muted-foreground">
                    {checkedCount} of {lookup.rows.length} checked
                  </span>
                  <Button onClick={handleSave} disabled={saving}>
                    {saving ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Save className="size-4" />
                    )}
                    Save
                  </Button>
                </div>
              </div>

              <div className="flex flex-col gap-3">
                {groups.map((group) => (
                  <details
                    key={group.level ?? "unspecified"}
                    open
                    className="rounded-lg border border-border"
                  >
                    <summary className="cursor-pointer bg-muted/40 px-3 py-2 text-sm font-semibold">
                      {group.level !== null ? `Semester ${group.level}` : "Unspecified level"}{" "}
                      <span className="font-normal text-muted-foreground">
                        ({group.rows.length} course{group.rows.length === 1 ? "" : "s"})
                      </span>
                    </summary>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Course</TableHead>
                            <TableHead>Class</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-center">Midterm</TableHead>
                            <TableHead className="text-center">Final</TableHead>
                            <TableHead className="text-center">All</TableHead>
                            <TableHead>Reason Type</TableHead>
                            <TableHead>Reason Note</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {group.rows.map((r) => {
                            const s = getState(r.enrollmentId);
                            const checked = s.midterm || s.final;
                            return (
                              <TableRow
                                key={r.enrollmentId}
                                className={checked ? "bg-primary/5" : undefined}
                              >
                                <TableCell className="font-medium">
                                  {r.courseName} ({r.courseCode})
                                </TableCell>
                                <TableCell className="text-muted-foreground">
                                  {r.className}
                                </TableCell>
                                <TableCell>
                                  <Badge variant={STATUS_VARIANT[r.status]}>{r.status}</Badge>
                                </TableCell>
                                <TableCell className="text-center">
                                  <Checkbox
                                    checked={s.midterm}
                                    onCheckedChange={(v) =>
                                      updateRow(r.enrollmentId, { midterm: !!v })
                                    }
                                  />
                                </TableCell>
                                <TableCell className="text-center">
                                  <Checkbox
                                    checked={s.final}
                                    onCheckedChange={(v) =>
                                      updateRow(r.enrollmentId, { final: !!v })
                                    }
                                  />
                                </TableCell>
                                <TableCell className="text-center">
                                  <Checkbox
                                    checked={s.midterm && s.final}
                                    onCheckedChange={(v) =>
                                      updateRow(r.enrollmentId, { midterm: !!v, final: !!v })
                                    }
                                  />
                                </TableCell>
                                <TableCell>
                                  <SearchableSelect
                                    value={s.reasonType}
                                    onValueChange={(v) =>
                                      updateRow(r.enrollmentId, {
                                        reasonType: v as MissedExamReasonType,
                                      })
                                    }
                                    items={REASON_TYPE_OPTIONS}
                                    className="w-36"
                                  />
                                </TableCell>
                                <TableCell>
                                  <Input
                                    value={s.reasonNote}
                                    onChange={(e) =>
                                      updateRow(r.enrollmentId, { reasonNote: e.target.value })
                                    }
                                    placeholder="Optional note…"
                                    className="min-w-40"
                                  />
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </details>
                ))}
                {groups.length === 0 && (
                  <p className="text-sm text-muted-foreground">No rows match this search.</p>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

interface EditFormState {
  examType: MissedExamType;
  reasonType: MissedExamReasonType;
  reasonNote: string;
}

// Small, focused edit dialog — Exam Type, Reason Type, Reason Note only
// (who/which course/which period a record is for never changes here;
// that would just be a different record). Reason Type uses the same
// SearchableSelect as everywhere else in this module.
function EditRecordDialog({
  record,
  onClose,
  onSaved,
}: {
  record: RecordRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<EditFormState>({
    examType: record.examType,
    reasonType: record.reasonType,
    reasonNote: record.reasonNote ?? "",
  });
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await updateMissedExamRecord(record.id, {
        examType: form.examType,
        reasonType: form.reasonType,
        reasonNote: form.reasonNote || undefined,
      });
      toast.success("Record updated.");
      onSaved();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not update the record."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit missed exam record</DialogTitle>
          <DialogDescription>
            {studentLabel(record.student)} — {record.enrollment.course.name}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>Exam Type</Label>
            <Select
              value={form.examType}
              onValueChange={(v) =>
                v && setForm((f) => ({ ...f, examType: v as MissedExamType }))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MIDTERM">Midterm</SelectItem>
                <SelectItem value="FINAL">Final</SelectItem>
                <SelectItem value="BOTH">Both (All)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Reason Type</Label>
            <SearchableSelect
              value={form.reasonType}
              onValueChange={(v) =>
                setForm((f) => ({ ...f, reasonType: v as MissedExamReasonType }))
              }
              items={REASON_TYPE_OPTIONS}
              className="w-full"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Reason Note</Label>
            <Input
              value={form.reasonNote}
              onChange={(e) => setForm((f) => ({ ...f, reasonNote: e.target.value }))}
              placeholder="Optional note…"
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MissedExamsClient({
  records,
  total,
  page,
  pageSize,
  periods,
  unassigned,
  canDelete,
}: {
  records: RecordRow[];
  total: number;
  page: number;
  pageSize: number;
  periods: ExamPeriodOption[];
  unassigned: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const table = useUrlTableState();
  const [editingRecord, setEditingRecord] = useState<RecordRow | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  function handleSaved() {
    setEditingRecord(null);
    router.refresh();
  }

  async function handleDelete(record: RecordRow) {
    if (
      !window.confirm(
        `Delete this missed exam record for ${studentLabel(record.student)} (${record.enrollment.course.name})? This cannot be undone.`
      )
    ) {
      return;
    }
    setDeletingId(record.id);
    try {
      await deleteMissedExamRecord(record.id);
      toast.success("Record deleted.");
      router.refresh();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not delete the record."));
    } finally {
      setDeletingId(null);
    }
  }

  if (unassigned) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Missed Exams"
          description="Register why a student missed a midterm/final exam."
        />
        <Card>
          <CardHeader>
            <CardTitle>No faculties assigned yet</CardTitle>
            <CardDescription>
              Contact the administrator to get faculties assigned to your
              account before you can register or view missed exam records.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Missed Exams"
        description="Register why students missed a midterm/final exam — no connection to grading or assessment content."
      />

      <BulkRegistrationSection periods={periods} />

      <div className="flex flex-col gap-3">
        <p className="text-sm font-semibold">Recorded missed exams</p>
        <div className="flex flex-wrap gap-3">
          <TableSearchInput
            value={table.search}
            onChange={table.setSearch}
            placeholder="Search by student or course…"
            className="w-full sm:w-72"
          />
          <div className="w-44">
            <Select
              value={table.getFilter("examType") || "all"}
              onValueChange={(value) =>
                table.setFilter("examType", value === "all" ? "" : (value ?? ""))
              }
              items={EXAM_TYPE_ITEMS}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="All exam types" />
              </SelectTrigger>
              <SelectContent>
                {EXAM_TYPE_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-44">
            <SearchableSelect
              value={table.getFilter("reasonType")}
              onValueChange={(value) => table.setFilter("reasonType", value)}
              items={REASON_TYPE_FILTER_ITEMS}
              placeholder="All reasons"
              className="w-full"
            />
          </div>
        </div>

        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader className="sticky top-0 bg-card">
              <TableRow>
                <TableHead>Student</TableHead>
                <TableHead>Course</TableHead>
                <TableHead>Class</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Exam</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Recorded by</TableHead>
                <TableHead className="text-right">When</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((r, i) => (
                <TableRow key={r.id} className={i % 2 === 1 ? "bg-muted/30" : undefined}>
                  <TableCell className="font-medium">{studentLabel(r.student)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.enrollment.course.name} ({r.enrollment.course.code})
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatClassLabel(r.enrollment.class)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.specialExamPeriod.name}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{EXAM_TYPE_LABEL[r.examType]}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={REASON_BADGE[r.reasonType].variant}>
                      {REASON_BADGE[r.reasonType].label}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.recordedBy.fullName}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {new Date(r.recordedAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setEditingRecord(r)}
                        title="Edit"
                      >
                        <Pencil className="size-4" />
                      </Button>
                      {canDelete && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => handleDelete(r)}
                          disabled={deletingId === r.id}
                          title="Delete"
                        >
                          {deletingId === r.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Trash2 className="size-4 text-destructive" />
                          )}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {records.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground">
                    No missed exam records match these filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <TablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={table.setPage}
            onPageSizeChange={table.setPageSize}
          />
        </div>
      </div>

      {editingRecord && (
        <EditRecordDialog
          record={editingRecord}
          onClose={() => setEditingRecord(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
