"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Download, Loader2, Users } from "lucide-react";
import type { Class, Course, LecturerCourseAssignment, Semester, AcademicYear } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { TablePagination } from "@/components/ui/table-pagination";
import { getActionErrorMessage } from "@/lib/action-error";
import { downloadBase64 } from "@/lib/download";
import { fetchClassResultReport, exportClassResultReport } from "./actions";
import type { getClassResultReport } from "./queries";
import type { StudentResultRow } from "./queries";

type ReportData = NonNullable<Awaited<ReturnType<typeof getClassResultReport>>>;
type AssignmentRow = LecturerCourseAssignment & {
  course: Course;
  class: Class;
  semester: Semester & { academicYear: AcademicYear };
};

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function markCell(m: StudentResultRow["marks"][string]) {
  if (!m) return "—";
  if (m.attendanceStatus === "ABSENT") return "Absent";
  if (m.attendanceStatus === "EXEMPT") return "Exempt";
  return m.mark ?? "—";
}

export function ReportsClient({ assignments }: { assignments: AssignmentRow[] }) {
  const [assignmentId, setAssignmentId] = useState("");
  const [report, setReport] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [search, setSearch] = useState("");
  const [groupView, setGroupView] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  async function onSelect(value: string) {
    setAssignmentId(value);
    setReport(null);
    setSearch("");
    setGroupView(false);
    setPage(1);
    if (!value) return;
    setLoading(true);
    try {
      setReport(await fetchClassResultReport(value));
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not load that report."));
    } finally {
      setLoading(false);
    }
  }

  async function onExport() {
    if (!assignmentId) return;
    setExporting(true);
    try {
      const { base64, fileName } = await exportClassResultReport(assignmentId);
      downloadBase64(base64, fileName, XLSX_MIME);
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not export that report."));
    } finally {
      setExporting(false);
    }
  }

  const filteredStudents =
    report?.students.filter((s) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return (
        s.studentNo.toLowerCase().includes(q) ||
        s.studentName.toLowerCase().includes(q)
      );
    }) ?? [];

  const hasGroups = (report?.groups.length ?? 0) > 0;

  const pagedStudents = filteredStudents.slice(
    (page - 1) * pageSize,
    page * pageSize,
  );

  const sections: { label: string | null; students: StudentResultRow[] }[] = !report
    ? []
    : !groupView
      ? [{ label: null, students: pagedStudents }]
      : (() => {
          const grouped = report.groups.map((g) => ({
            label: g.name,
            students: filteredStudents.filter((s) => s.groupId === g.id),
          }));
          const ungrouped = filteredStudents.filter((s) => s.groupId === null);
          return ungrouped.length > 0
            ? [...grouped, { label: "Ungrouped", students: ungrouped }]
            : grouped;
        })();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Reports"
        description="Class results for your assigned courses — read-only."
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-96">
          <Label className="mb-1.5 block">Course</Label>
          <SearchableSelect
            value={assignmentId}
            onValueChange={onSelect}
            items={assignments.map((a) => ({
              value: a.id,
              label: `${a.course.name} — ${a.class.name} — ${a.semester.name}`,
            }))}
            placeholder="Select one of your courses"
            searchPlaceholder="Search…"
            className="w-full"
          />
        </div>
        {report && (
          <>
            <div className="w-64">
              <Label className="mb-1.5 block">Search student</Label>
              <Input
                placeholder="Student no. or name…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            {hasGroups && (
              <Button
                type="button"
                variant={groupView ? "default" : "outline"}
                onClick={() => {
                  setGroupView((v) => !v);
                  setPage(1);
                }}
              >
                <Users className="size-4" />
                Group view
              </Button>
            )}
            <Button variant="outline" onClick={onExport} disabled={exporting}>
              {exporting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              Export to Excel
            </Button>
          </>
        )}
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {report && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            {report.assignment.course.name} · {report.assignment.class.name} ·{" "}
            {report.assignment.semester.name} (
            {report.assignment.semester.academicYear.name})
          </p>

          {sections.map((section) => (
            <div key={section.label ?? "all"} className="flex flex-col gap-2">
              {section.label && (
                <p className="text-sm font-semibold">{section.label}</p>
              )}
              <div className="overflow-x-auto rounded-lg border border-border">
                <Table>
                  <TableHeader className="sticky top-0 bg-card">
                    <TableRow>
                      <TableHead>Student</TableHead>
                      {report.assessments.map((a) => (
                        <TableHead key={a.id} className="text-right">
                          <div className="flex flex-col items-end gap-0.5">
                            <span>{a.title}</span>
                            <Badge
                              variant={a.status === "DRAFT" ? "draft" : "published"}
                              className="text-[10px]"
                            >
                              {a.status === "DRAFT" ? "Draft" : "Published"}
                            </Badge>
                          </div>
                        </TableHead>
                      ))}
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">%</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {section.students.map((s, i) => (
                      <TableRow
                        key={s.enrollmentId}
                        className={i % 2 === 1 ? "bg-muted/30" : undefined}
                      >
                        <TableCell className="font-medium">
                          {s.studentName}{" "}
                          <span className="text-muted-foreground">({s.studentNo})</span>
                        </TableCell>
                        {report.assessments.map((a) => {
                          const m = s.marks[a.id];
                          return (
                            <TableCell key={a.id} className="text-right">
                              <span className="inline-flex items-center gap-1">
                                {m?.isCorrected && (
                                  <Badge variant="outline" className="text-[10px]">
                                    C
                                  </Badge>
                                )}
                                {markCell(m)}
                              </span>
                            </TableCell>
                          );
                        })}
                        <TableCell className="text-right font-medium">
                          {s.earned} / {s.possible}
                        </TableCell>
                        <TableCell className="text-right">
                          {s.percentage !== null ? `${s.percentage.toFixed(1)}%` : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                    {section.students.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={report.assessments.length + 3}
                          className="text-center text-muted-foreground"
                        >
                          {search
                            ? "No students match your search."
                            : "No students in this group."}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          ))}

          {!groupView && filteredStudents.length > 0 && (
            <TablePagination
              page={page}
              pageSize={pageSize}
              total={filteredStudents.length}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
            />
          )}

          {report.students.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No active enrollments in this course.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
