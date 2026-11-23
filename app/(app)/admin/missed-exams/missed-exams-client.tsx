"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Save, Pencil, Trash2, Search, CheckCircle2 } from "lucide-react";
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
import type { NewReasonType } from "./schema";
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
];

// Reason Type is a small, fixed 4-value list — same shape as everywhere
// else in this app — but rendered via SearchableSelect (not a plain
// Select) per an explicit visual/UX-consistency request, reused
// identically wherever Reason Type appears in this module (the filter
// bar below, the bulk grid's per-row picker, and the edit dialog).
const REASON_TYPE_OPTIONS = [
  { value: "FINANCE", label: "Finance" },
  { value: "ILLNESS", label: "Illness" },
  { value: "LATE", label: "Late" },
  { value: "OTHER", label: "Other" },
];
// CHEATING/EMERGENCY are LEGACY: never offered for new registrations or
// edits, but old records stay readable and filterable.
const REASON_TYPE_FILTER_ITEMS = [
  { value: "", label: "All reasons" },
  ...REASON_TYPE_OPTIONS,
  { value: "CHEATING", label: "Cheating (legacy)" },
  { value: "EMERGENCY", label: "Emergency (legacy)" },
];

// MissedExamType still contains BOTH in the DB enum (legacy), but it is
// never written anymore — exam type always equals the period's phase.
const EXAM_TYPE_LABEL: Record<MissedExamType, string> = {
  MIDTERM: "Midterm",
  FINAL: "Final",
  BOTH: "Both",
};

const REASON_BADGE: Record<
  MissedExamReasonType,
  { label: string; variant: "destructive" | "draft" | "secondary" | "outline" }
> = {
  FINANCE: { label: "Finance", variant: "secondary" },
  ILLNESS: { label: "Illness", variant: "draft" },
  LATE: { label: "Late", variant: "outline" },
  CHEATING: { label: "Cheating", variant: "destructive" },
  EMERGENCY: { label: "Emergency", variant: "secondary" },
  OTHER: { label: "Other", variant: "outline" },
};

function studentLabel(student: { studentNo: string; fullName: string }): string {
  return `${student.studentNo} — ${student.fullName}`;
}

interface RowState {
  missed: boolean;
  // "" until picked — Register stays disabled until set.
  reasonType: NewReasonType | "";
  reasonNote: string;
}

function defaultRowState(): RowState {
  return { missed: false, reasonType: "", reasonNote: "" };
}
// Large, easy-to-tap checkbox for non-technical staff; the shared
// Checkbox component itself is untouched.
const LARGE_CHECKBOX_CLASS = "size-6 [&_svg]:size-4";

// Radio-style chips for Reason Type (only the four reasons offered for
// NEW registrations — legacy Cheating/Emergency are never selectable).
function ReasonChips({
  value,
  onChange,
  label,
}: {
  value: NewReasonType | "";
  onChange: (v: NewReasonType) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {REASON_TYPE_OPTIONS.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value as NewReasonType)}
            className={`h-11 min-w-24 flex-1 rounded-lg border px-4 text-base font-medium transition-colors sm:flex-none ${
              active
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background hover:bg-muted"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function StepCard({
  step,
  title,
  help,
  children,
}: {
  step: number;
  title: string;
  help: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="gap-4 p-4 sm:p-6">
      <div>
        <h2 className="text-xl font-semibold">
          {step}. {title}
        </h2>
        <p className="text-base text-muted-foreground">{help}</p>
      </div>
      {children}
    </Card>
  );
}

function courseSourceNote(lookup: StudentLookupData): string {
  if (lookup.source === "enrollments") {
    return "Showing this student's courses for this semester.";
  }
  if (lookup.source === "coursePlan") {
    return `No enrollments found — showing the class course plan (Semester ${lookup.planSemesterNumber}).`;
  }
  return "No course plan found — showing all courses. Tick only the courses this student actually missed.";
}

function BulkRegistrationSection({ periods }: { periods: ExamPeriodOption[] }) {
  const router = useRouter();
  const table = useUrlTableState();
  // The selected period lives in the URL (?periodId=) so the server can
  // filter the records list below by it. An id that isn't an OPEN period
  // (stale link) counts as "none selected".
  const urlPeriodId = table.getFilter("periodId");
  const periodId = periods.some((p) => p.id === urlPeriodId) ? urlPeriodId : "";
  const [studentNoInput, setStudentNoInput] = useState("");
  const [looking, setLooking] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookup, setLookup] = useState<StudentLookupData | null>(null);
  const [rowState, setRowState] = useState<Map<string, RowState>>(new Map());
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  // Items map (value -> label) so the trigger shows the period NAME, not
  // the raw id — base-ui's Select renders the raw value when it has no
  // items to resolve a label from.
  const periodItems = useMemo(
    () => periods.map((p) => ({ value: p.id, label: p.name })),
    [periods]
  );

  async function runLookup(studentNo: string, forPeriodId: string) {
    setLooking(true);
    setLookupError(null);
    try {
      const result = await lookupStudentForMissedExam(studentNo, forPeriodId);
      if (!result) {
        setLookup(null);
        setLookupError(
          "We could not find a student with that ID. Please check the number and try again."
        );
      } else {
        setLookup(result);
        setRowState(new Map());
        setSearch("");
      }
    } catch (error) {
      setLookup(null);
      setLookupError(getActionErrorMessage(error, "Could not look up that student."));
    } finally {
      setLooking(false);
    }
  }

  function handleLookup() {
    const trimmed = studentNoInput.trim();
    if (!trimmed || !periodId) return;
    setSuccess(null);
    runLookup(trimmed, periodId);
  }

  // The course list depends on the period's semester, so changing the
  // period invalidates any looked-up grid.
  function handlePeriodChange(next: string) {
    setLookup(null);
    setLookupError(null);
    setRowState(new Map());
    table.setFilter("periodId", next);
  }

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

  const checkedRows = (lookup?.courses ?? []).filter((c) => rowState.get(c.id)?.missed);
  const checkedCount = checkedRows.length;
  const missingReasonCount = checkedRows.filter((c) => !rowState.get(c.id)?.reasonType).length;
  const canRegister = checkedCount > 0 && missingReasonCount === 0 && !saving;
  const registerHint =
    checkedCount === 0
      ? "Tick at least one missed course to continue."
      : missingReasonCount > 0
        ? `Choose a reason for ${missingReasonCount} ticked course${missingReasonCount === 1 ? "" : "s"} to continue.`
        : null;

  const visibleCheckedCount = visibleCourses.filter((c) => getState(c.id).missed).length;
  const allVisibleChecked =
    visibleCourses.length > 0 && visibleCheckedCount === visibleCourses.length;
  const someVisibleChecked = visibleCheckedCount > 0 && !allVisibleChecked;

  function toggleAllVisible(checked: boolean) {
    setRowState((prev) => {
      const next = new Map(prev);
      for (const c of visibleCourses) {
        next.set(c.id, { ...(prev.get(c.id) ?? defaultRowState()), missed: checked });
      }
      return next;
    });
  }

  function applyReasonToAllTicked(reason: NewReasonType) {
    setRowState((prev) => {
      const next = new Map(prev);
      for (const c of checkedRows) {
        next.set(c.id, { ...(prev.get(c.id) ?? defaultRowState()), reasonType: reason });
      }
      return next;
    });
  }

  async function handleRegister() {
    if (!periodId || !lookup || !canRegister) return;
    const submitRows = checkedRows.map((c) => {
      const s = rowState.get(c.id)!;
      return {
        courseId: c.id,
        reasonType: s.reasonType as NewReasonType,
        reasonNote: s.reasonNote || undefined,
      };
    });
    const studentName = lookup.student.fullName;

    setSaving(true);
    try {
      const result = await recordMissedExamsBulk({
        specialExamPeriodId: periodId,
        studentId: lookup.student.id,
        rows: submitRows,
      });
      // Clear the student so staff can enter the next one. No server
      // action is awaited after router.refresh() (that would swallow the
      // refresh and leave the records list stale).
      setLookup(null);
      setRowState(new Map());
      setStudentNoInput("");
      setSearch("");
      setSuccess(
        `Registered ${result.created} missed exam${result.created === 1 ? "" : "s"} for ${studentName}.` +
          (result.skipped > 0 ? ` (${result.skipped} skipped.)` : "")
      );
      router.refresh();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not register. Please try again."));
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

  const registerButton = (
    <Button
      onClick={handleRegister}
      disabled={!canRegister}
      className="h-12 w-full px-6 text-base sm:w-auto"
    >
      {saving ? <Loader2 className="size-5 animate-spin" /> : <Save className="size-5" />}
      Register {checkedCount} missed exam{checkedCount === 1 ? "" : "s"}
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      {success && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-lg border border-green-600/40 bg-green-50 p-4 text-lg font-semibold text-green-900 dark:bg-green-950/40 dark:text-green-200"
        >
          <CheckCircle2 className="mt-0.5 size-6 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      <StepCard
        step={1}
        title="Choose the exam period"
        help="Pick the exam period the student missed."
      >
        <Select
          value={periodId}
          onValueChange={(value) => handlePeriodChange(value ?? "")}
          items={periodItems}
        >
          <SelectTrigger className="h-11 w-full text-base sm:max-w-md">
            <SelectValue placeholder="Select a period" />
          </SelectTrigger>
          <SelectContent>
            {periodItems.map((p) => (
              <SelectItem key={p.value} value={p.value} className="text-base">
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </StepCard>

      <StepCard
        step={2}
        title="Find the student"
        help="Type the student's ID number, then press Find student."
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={studentNoInput}
            onChange={(e) => setStudentNoInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleLookup();
              }
            }}
            placeholder="Student ID, e.g. S1001"
            disabled={!periodId}
            aria-label="Student ID"
            className="h-11 text-base sm:max-w-md"
          />
          <Button
            onClick={handleLookup}
            disabled={!periodId || !studentNoInput.trim() || looking}
            className="h-11 w-full px-6 text-base sm:w-auto"
          >
            {looking ? <Loader2 className="size-5 animate-spin" /> : <Search className="size-5" />}
            Find student
          </Button>
        </div>
        {!periodId && (
          <p className="text-base text-muted-foreground">
            Choose the exam period in step 1 first.
          </p>
        )}
        {lookupError && (
          <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-base text-destructive">
            {lookupError}
          </p>
        )}
        {lookup && (
          <div className="rounded-lg border-2 border-primary/40 bg-primary/5 p-4">
            <p className="text-sm text-muted-foreground">Student found</p>
            <p className="text-xl font-semibold">{lookup.student.fullName}</p>
            <p className="text-base">
              ID: <span className="font-medium">{lookup.student.studentNo}</span>
              {" · "}
              Class:{" "}
              <span className="font-medium">{lookup.student.className ?? "No class"}</span>
            </p>
          </div>
        )}
      </StepCard>

      {lookup && (
        <StepCard
          step={3}
          title="Tick the missed courses and choose a reason"
          help="Tick each course the student missed, then choose why."
        >
          <p className="rounded-lg bg-muted p-3 text-base">{courseSourceNote(lookup)}</p>

          {lookup.registered.length > 0 && (
            <p className="text-base text-muted-foreground">
              Already registered:{" "}
              {lookup.registered.map((c) => `${c.name} (${c.code})`).join(", ")}
            </p>
          )}

          {lookup.courses.length === 0 ? (
            <p className="text-base text-muted-foreground">
              {lookup.registered.length > 0
                ? "Every course for this student is already registered for this period."
                : "No courses are available for this student."}
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <label className="flex items-center gap-3 text-base font-medium">
                  <Checkbox
                    checked={allVisibleChecked}
                    indeterminate={someVisibleChecked}
                    onCheckedChange={(v) => toggleAllVisible(!!v)}
                    aria-label="Check all"
                    className={LARGE_CHECKBOX_CLASS}
                  />
                  Check all
                  <span className="font-normal text-muted-foreground">
                    ({checkedCount} of {lookup.courses.length} ticked)
                  </span>
                </label>
                {registerButton}
              </div>
              {registerHint && (
                <p className="text-base text-muted-foreground">{registerHint}</p>
              )}

              <TableSearchInput
                value={search}
                onChange={setSearch}
                placeholder="Search by course name or code…"
                className="w-full sm:max-w-md [&_input]:h-11 [&_input]:text-base"
              />

              {checkedCount > 0 && (
                <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                  <p className="text-base font-medium">
                    Apply this reason to all ticked courses
                  </p>
                  <ReasonChips
                    value=""
                    onChange={applyReasonToAllTicked}
                    label="Apply reason to all ticked courses"
                  />
                </div>
              )}

              <div className="flex flex-col gap-2">
                {visibleCourses.map((c: CourseOption) => {
                  const s = getState(c.id);
                  const checked = s.missed;
                  return (
                    <div
                      key={c.id}
                      className={`rounded-lg border p-3 sm:p-4 ${
                        checked ? "border-primary/50 bg-primary/5" : "border-border"
                      }`}
                    >
                      <label className="flex cursor-pointer items-center gap-3 text-base font-medium">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(v) => updateRow(c.id, { missed: !!v })}
                          className={LARGE_CHECKBOX_CLASS}
                        />
                        <span>
                          {c.name} <span className="text-muted-foreground">({c.code})</span>
                        </span>
                      </label>
                      {checked && (
                        <div className="mt-3 flex flex-col gap-3 sm:pl-9">
                          <div className="flex flex-col gap-1">
                            <Label className="text-base">Reason</Label>
                            <ReasonChips
                              value={s.reasonType}
                              onChange={(v) => updateRow(c.id, { reasonType: v })}
                              label={`Reason for ${c.name}`}
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <Label className="text-base">Note (optional)</Label>
                            <Input
                              value={s.reasonNote}
                              onChange={(e) => updateRow(c.id, { reasonNote: e.target.value })}
                              placeholder="Add a short note if needed"
                              className="h-11 text-base"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {visibleCourses.length === 0 && (
                  <p className="p-3 text-center text-base text-muted-foreground">
                    No courses match this search.
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-2 border-t border-border pt-4">
                {registerHint && (
                  <p className="text-base text-muted-foreground">{registerHint}</p>
                )}
                {registerButton}
              </div>
            </>
          )}
        </StepCard>
      )}
    </div>
  );
}

interface EditFormState {
  // "" for a legacy record (Cheating/Emergency) until a new reason is picked.
  reasonType: NewReasonType | "";
  reasonNote: string;
}

// Small, focused edit dialog — Reason Type, Reason Note only (who/which
// course/which period a record is for never changes here, and the exam
// type is fixed by the period's phase). Reason Type uses the same
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
  const isLegacyReason =
    record.reasonType === "CHEATING" || record.reasonType === "EMERGENCY";
  const [form, setForm] = useState<EditFormState>({
    reasonType: record.reasonType === "CHEATING" || record.reasonType === "EMERGENCY" ? "" : record.reasonType,
    reasonNote: record.reasonNote ?? "",
  });
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!form.reasonType) return;
    setSaving(true);
    try {
      await updateMissedExamRecord(record.id, {
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
            <Label>Reason Type</Label>
            <SearchableSelect
              value={form.reasonType}
              onValueChange={(v) =>
                setForm((f) => ({ ...f, reasonType: v as NewReasonType }))
              }
              items={REASON_TYPE_OPTIONS}
              placeholder="Choose a reason…"
              className="w-full"
            />
            {isLegacyReason && (
              <p className="text-sm text-muted-foreground">
                Current reason: {REASON_BADGE[record.reasonType].label} (legacy) — choose a
                new reason to save.
              </p>
            )}
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
          <Button onClick={handleSave} disabled={saving || !form.reasonType}>
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
  mode,
  canDelete,
}: {
  records: RecordRow[];
  total: number;
  page: number;
  pageSize: number;
  periods: ExamPeriodOption[];
  unassigned: boolean;
  mode: "register" | "records";
  canDelete: boolean;
}) {
  const router = useRouter();
  const table = useUrlTableState();
  const pathname = usePathname();
  const base = pathname.startsWith("/dean") ? "/dean" : "/admin";
  const isRegister = mode === "register";
  const selectedPeriodId = table.getFilter("periodId");
  const periodFilterItems = useMemo(
    () => [
      { value: "", label: "All periods" },
      ...periods.map((p) => ({ value: p.id, label: p.name })),
    ],
    [periods]
  );
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
        title={isRegister ? "Missed Exams" : "Missed Exam Records"}
        description={
          isRegister
            ? "Register why students missed a midterm/final exam — no connection to grading or assessment content."
            : "All recorded missed exams, filterable by period, exam type and reason."
        }
        action={
          <Button
            variant="outline"
            nativeButton={false}
            render={
              <Link href={isRegister ? `${base}/missed-exams/records` : `${base}/missed-exams`} />
            }
          >
            {isRegister ? "View all records" : "Register missed exams"}
          </Button>
        }
      />

      {isRegister && <BulkRegistrationSection periods={periods} />}

      {isRegister && !selectedPeriodId ? null : (
      <div className="flex flex-col gap-3">
        <p className="text-sm font-semibold">
          {isRegister ? "Records for the selected period" : "Recorded missed exams"}
        </p>
        <div className="flex flex-wrap gap-3">
          {!isRegister && (
            <div className="w-56">
              <SearchableSelect
                value={selectedPeriodId}
                onValueChange={(value) => table.setFilter("periodId", value)}
                items={periodFilterItems}
                placeholder="All periods"
                className="w-full"
              />
            </div>
          )}
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
                    {r.reasonNote && (
                      <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                        {r.reasonNote}
                      </p>
                    )}
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
      )}

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
