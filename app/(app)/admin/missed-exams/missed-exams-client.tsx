"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Save, Pencil, Trash2 } from "lucide-react";
import type { MissedExamType, MissedExamReasonType } from "@prisma/client";
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
import type { ExamPeriodOption, ClassOption, MissedExamGridRow } from "./queries";
import {
  getClassesForLevelAction,
  getMissedExamGridRowsAction,
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
  course: { name: string; code: string };
  assignment: { class: { name: string; currentSemesterNumber: number | null } };
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

function studentLabel(student: { studentNo: string; fullName: string }): string {
  return `${student.studentNo} — ${student.fullName}`;
}

interface RowState {
  midterm: boolean;
  final: boolean;
  reasonType: MissedExamReasonType;
  reasonNote: string;
}

function rowKey(r: { studentId: string; assignmentId: string }): string {
  return `${r.studentId}:${r.assignmentId}`;
}

function defaultRowState(): RowState {
  return { midterm: false, final: false, reasonType: "ILLNESS", reasonNote: "" };
}

function BulkRegistrationSection({
  periods,
  activeSemesterId,
  classLevels,
}: {
  periods: ExamPeriodOption[];
  activeSemesterId: string | null;
  classLevels: number[];
}) {
  const router = useRouter();
  const defaultPeriodId =
    periods.find((p) => p.semesterId === activeSemesterId)?.id ?? "";

  const [periodId, setPeriodId] = useState(defaultPeriodId);
  const [level, setLevel] = useState<string>("");
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [loadingClasses, setLoadingClasses] = useState(false);
  const [classId, setClassId] = useState("");
  const [rows, setRows] = useState<MissedExamGridRow[]>([]);
  const [loadingRows, setLoadingRows] = useState(false);
  const [rowState, setRowState] = useState<Map<string, RowState>>(new Map());
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!level) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing the stale class list for the now-empty level pick, same pattern as send-notification-client.tsx's setPreview(null)
      setClasses([]);
      setClassId("");
      return;
    }
    let cancelled = false;
    setClassId("");
    setLoadingClasses(true);
    getClassesForLevelAction(Number(level))
      .then((opts) => {
        if (!cancelled) setClasses(opts);
      })
      .finally(() => {
        if (!cancelled) setLoadingClasses(false);
      });
    return () => {
      cancelled = true;
    };
  }, [level]);

  useEffect(() => {
    if (!classId || !periodId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing the stale grid for the now-empty pick, same pattern as send-notification-client.tsx's setPreview(null)
      setRows([]);
      setRowState(new Map());
      return;
    }
    let cancelled = false;
    setLoadingRows(true);
    getMissedExamGridRowsAction(classId, periodId)
      .then((r) => {
        if (!cancelled) {
          setRows(r);
          setRowState(new Map());
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingRows(false);
      });
    return () => {
      cancelled = true;
    };
  }, [classId, periodId]);

  const visibleRows = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        r.studentNo.toLowerCase().includes(q) ||
        r.studentFullName.toLowerCase().includes(q) ||
        r.courseName.toLowerCase().includes(q)
    );
  }, [rows, search]);

  function getState(key: string): RowState {
    return rowState.get(key) ?? defaultRowState();
  }

  function updateRow(key: string, patch: Partial<RowState>) {
    setRowState((prev) => {
      const next = new Map(prev);
      next.set(key, { ...getState(key), ...patch });
      return next;
    });
  }

  const checkedCount = rows.filter((r) => {
    const s = rowState.get(rowKey(r));
    return s && (s.midterm || s.final);
  }).length;

  const selectedPeriod = periods.find((p) => p.id === periodId);

  async function handleSave() {
    if (!periodId || !classId) return;
    const submitRows = rows
      .map((r) => {
        const s = rowState.get(rowKey(r));
        if (!s || (!s.midterm && !s.final)) return null;
        const examType: MissedExamType =
          s.midterm && s.final ? "BOTH" : s.midterm ? "MIDTERM" : "FINAL";
        return {
          enrollmentId: r.enrollmentId,
          studentId: r.studentId,
          assignmentId: r.assignmentId,
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
        classId,
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
      toast.error(
        getActionErrorMessage(error, "Could not save. Please try again.")
      );
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
          <Select value={periodId} onValueChange={(value) => setPeriodId(value ?? "")}>
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
        <div className="w-44">
          <label className="mb-1 block text-sm font-medium">Semester Level</label>
          <Select value={level} onValueChange={(value) => setLevel(value ?? "")}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a level" />
            </SelectTrigger>
            <SelectContent>
              {classLevels.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  Semester {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-64">
          <label className="mb-1 block text-sm font-medium">Class</label>
          <SearchableSelect
            value={classId}
            onValueChange={setClassId}
            items={classes.map((c) => ({ value: c.id, label: formatClassLabel(c) }))}
            placeholder={
              !level ? "Select a level first" : loadingClasses ? "Loading…" : "Select a class"
            }
            disabled={!level || loadingClasses}
            className="w-full"
          />
        </div>
      </div>

      {!activeSemesterId ? null : !selectedPeriod ? (
        <p className="text-sm text-muted-foreground">
          Pick a Special Exam Period above to load its class roster.
        </p>
      ) : selectedPeriod.semesterId !== activeSemesterId ? (
        <p className="text-sm text-amber-600 dark:text-amber-400">
          Note: this period isn&apos;t the currently active academic-calendar
          semester — you&apos;re registering against a different semester on
          purpose, which is fine for retroactive entry.
        </p>
      ) : null}

      {classId && periodId && (
        <>
          <div className="flex items-center justify-between gap-3">
            <TableSearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search by student or course…"
              className="w-full sm:w-72"
            />
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">
                {checkedCount} of {rows.length} checked
              </span>
              <Button onClick={handleSave} disabled={saving || loadingRows}>
                {saving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
                Save
              </Button>
            </div>
          </div>

          <div className="max-h-[32rem] overflow-auto rounded-lg border border-border">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Student</TableHead>
                  <TableHead>Course</TableHead>
                  <TableHead className="text-center">Midterm</TableHead>
                  <TableHead className="text-center">Final</TableHead>
                  <TableHead className="text-center">All</TableHead>
                  <TableHead>Reason Type</TableHead>
                  <TableHead>Reason Note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingRows && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground">
                      Loading…
                    </TableCell>
                  </TableRow>
                )}
                {!loadingRows &&
                  visibleRows.map((r, i) => {
                    const key = rowKey(r);
                    const s = getState(key);
                    const checked = s.midterm || s.final;
                    return (
                      <TableRow
                        key={key}
                        className={
                          checked
                            ? "bg-primary/5"
                            : i % 2 === 1
                              ? "bg-muted/30"
                              : undefined
                        }
                      >
                        <TableCell className="font-medium">
                          {studentLabel({ studentNo: r.studentNo, fullName: r.studentFullName })}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {r.courseName} ({r.courseCode})
                        </TableCell>
                        <TableCell className="text-center">
                          <Checkbox
                            checked={s.midterm}
                            onCheckedChange={(v) => updateRow(key, { midterm: !!v })}
                          />
                        </TableCell>
                        <TableCell className="text-center">
                          <Checkbox
                            checked={s.final}
                            onCheckedChange={(v) => updateRow(key, { final: !!v })}
                          />
                        </TableCell>
                        <TableCell className="text-center">
                          <Checkbox
                            checked={s.midterm && s.final}
                            onCheckedChange={(v) =>
                              updateRow(key, { midterm: !!v, final: !!v })
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <SearchableSelect
                            value={s.reasonType}
                            onValueChange={(v) =>
                              updateRow(key, { reasonType: v as MissedExamReasonType })
                            }
                            items={REASON_TYPE_OPTIONS}
                            className="w-36"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            value={s.reasonNote}
                            onChange={(e) => updateRow(key, { reasonNote: e.target.value })}
                            placeholder="Optional note…"
                            className="min-w-40"
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                {!loadingRows && visibleRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground">
                      {rows.length === 0
                        ? "No active enrollments found for this class in this period's semester."
                        : "No rows match this search."}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
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
            {studentLabel(record.student)} — {record.course.name}
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
  activeSemesterId,
  classLevels,
  unassigned,
  canDelete,
}: {
  records: RecordRow[];
  total: number;
  page: number;
  pageSize: number;
  periods: ExamPeriodOption[];
  activeSemesterId: string | null;
  classLevels: number[];
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
        `Delete this missed exam record for ${studentLabel(record.student)} (${record.course.name})? This cannot be undone.`
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

      <BulkRegistrationSection
        periods={periods}
        activeSemesterId={activeSemesterId}
        classLevels={classLevels}
      />

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
                    {r.course.name} ({r.course.code})
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatClassLabel(r.assignment.class)}
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
