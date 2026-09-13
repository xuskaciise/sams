"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Save } from "lucide-react";
import type { MissedExamType, MissedExamReasonType } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
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

const REASON_TYPE_ITEMS = [
  { value: "all", label: "All reasons" },
  { value: "ILLNESS", label: "Illness" },
  { value: "CHEATING", label: "Cheating" },
  { value: "EMERGENCY", label: "Emergency" },
  { value: "OTHER", label: "Other" },
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
                          <Select
                            value={s.reasonType}
                            onValueChange={(v) =>
                              updateRow(key, { reasonType: v as MissedExamReasonType })
                            }
                          >
                            <SelectTrigger className="w-36">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="ILLNESS">Illness</SelectItem>
                              <SelectItem value="CHEATING">Cheating</SelectItem>
                              <SelectItem value="EMERGENCY">Emergency</SelectItem>
                              <SelectItem value="OTHER">Other</SelectItem>
                            </SelectContent>
                          </Select>
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

export function MissedExamsClient({
  records,
  total,
  page,
  pageSize,
  periods,
  activeSemesterId,
  classLevels,
  unassigned,
}: {
  records: RecordRow[];
  total: number;
  page: number;
  pageSize: number;
  periods: ExamPeriodOption[];
  activeSemesterId: string | null;
  classLevels: number[];
  unassigned: boolean;
}) {
  const table = useUrlTableState();

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
            <Select
              value={table.getFilter("reasonType") || "all"}
              onValueChange={(value) =>
                table.setFilter("reasonType", value === "all" ? "" : (value ?? ""))
              }
              items={REASON_TYPE_ITEMS}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="All reasons" />
              </SelectTrigger>
              <SelectContent>
                {REASON_TYPE_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
                </TableRow>
              ))}
              {records.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
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
    </div>
  );
}
