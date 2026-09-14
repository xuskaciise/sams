"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Save, Pencil, Trash2, Search } from "lucide-react";
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
import type { ExamPeriodOption, CourseOption } from "./queries";
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
  student: {
    studentNo: string;
    fullName: string;
    class: { name: string; currentSemesterNumber: number | null };
  };
  course: { name: string; code: string };
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

function defaultRowState(): RowState {
  return { midterm: false, final: false, reasonType: "ILLNESS", reasonNote: "" };
}

// Noticeably larger than this app's default size-4/16px checkboxes
// (size-6/24px box, size-4/16px check icon — up from size-3.5) for
// easier tap targets on this specific grid, per an explicit UI-polish
// request; the shared Checkbox component itself is untouched, so every
// other checkbox in the app keeps its normal size. mx-auto centers the
// checkbox itself within its TableCell — `text-center` alone only
// centers INLINE content, and Checkbox's root renders as a block-level
// flex box, so it needs its own centering on top of that.
const LARGE_CHECKBOX_CLASS = "size-6 [&_svg]:size-4 mx-auto";

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
      const result = await lookupStudentForMissedExam(trimmed);
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

  // ALL system courses are shown regardless of which period is selected
  // (courses aren't derived from the period's semester in any way), so —
  // unlike the earlier enrollment/parity-derived design — picking a
  // different period no longer needs to invalidate an in-progress grid.
  // The period only matters at Save time (which period the records get
  // attached to, and whether it's still OPEN).

  const visibleCourses = useMemo(() => {
    const courses = lookup?.courses ?? [];
    if (!search.trim()) return courses;
    const q = search.trim().toLowerCase();
    return courses.filter(
      (c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q)
    );
  }, [lookup, search]);

  function getState(courseId: string): RowState {
    return rowState.get(courseId) ?? defaultRowState();
  }

  function updateRow(courseId: string, patch: Partial<RowState>) {
    setRowState((prev) => {
      const next = new Map(prev);
      next.set(courseId, { ...getState(courseId), ...patch });
      return next;
    });
  }

  const checkedCount = (lookup?.courses ?? []).filter((c) => {
    const s = rowState.get(c.id);
    return s && (s.midterm || s.final);
  }).length;

  async function handleSave() {
    if (!periodId || !lookup) return;
    const submitRows = lookup.courses
      .map((c) => {
        const s = rowState.get(c.id);
        if (!s || (!s.midterm && !s.final)) return null;
        const examType: MissedExamType =
          s.midterm && s.final ? "BOTH" : s.midterm ? "MIDTERM" : "FINAL";
        return {
          courseId: c.id,
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
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
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
            check off whichever of the courses below actually apply to this
            student (not filtered by enrollment — every course in the
            system is listed).
          </p>

          <div className="flex items-center justify-between gap-3">
            <TableSearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search by course name or code…"
              className="w-full sm:w-72"
            />
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">
                {checkedCount} of {lookup.courses.length} checked
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

          <div className="overflow-x-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Course</TableHead>
                  <TableHead className="text-center">Midterm</TableHead>
                  <TableHead className="text-center">Final</TableHead>
                  <TableHead className="text-center">All</TableHead>
                  <TableHead>Reason Type</TableHead>
                  <TableHead>Reason Note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleCourses.map((c: CourseOption) => {
                  const s = getState(c.id);
                  const checked = s.midterm || s.final;
                  return (
                    <TableRow key={c.id} className={checked ? "bg-primary/5" : undefined}>
                      <TableCell className="font-medium">
                        {c.name} ({c.code})
                      </TableCell>
                      <TableCell className="text-center">
                        <Checkbox
                          checked={s.midterm}
                          onCheckedChange={(v) => updateRow(c.id, { midterm: !!v })}
                          className={LARGE_CHECKBOX_CLASS}
                        />
                      </TableCell>
                      <TableCell className="text-center">
                        <Checkbox
                          checked={s.final}
                          onCheckedChange={(v) => updateRow(c.id, { final: !!v })}
                          className={LARGE_CHECKBOX_CLASS}
                        />
                      </TableCell>
                      <TableCell className="text-center">
                        <Checkbox
                          checked={s.midterm && s.final}
                          onCheckedChange={(v) =>
                            updateRow(c.id, { midterm: !!v, final: !!v })
                          }
                          className={LARGE_CHECKBOX_CLASS}
                        />
                      </TableCell>
                      <TableCell>
                        <SearchableSelect
                          value={s.reasonType}
                          onValueChange={(v) =>
                            updateRow(c.id, { reasonType: v as MissedExamReasonType })
                          }
                          items={REASON_TYPE_OPTIONS}
                          disabled={!checked}
                          className="w-36"
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          value={s.reasonNote}
                          onChange={(e) => updateRow(c.id, { reasonNote: e.target.value })}
                          placeholder="Optional note…"
                          disabled={!checked}
                          className="min-w-40"
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
                {visibleCourses.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      No courses match this search.
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
                    {r.course.name} ({r.course.code})
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatClassLabel(r.student.class)}
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
