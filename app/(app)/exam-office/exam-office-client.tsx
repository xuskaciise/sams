"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Download, Loader2 } from "lucide-react";
import type { MissedExamType, MissedExamReasonType } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { PageHeader } from "@/components/layout/page-header";
import { TableSearchInput } from "@/components/ui/table-search-input";
import { TablePagination } from "@/components/ui/table-pagination";
import { useUrlTableState } from "@/lib/use-url-table-state";
import { formatClassLabel } from "@/lib/class-label";
import { downloadBase64 } from "@/lib/download";
import { getActionErrorMessage } from "@/lib/action-error";
import type { ExamOfficeRecord } from "./queries";
import { exportMissedExamReport } from "./actions";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

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

export function ExamOfficeClient({
  records,
  total,
  page,
  pageSize,
  semesters,
  departments,
  courses,
}: {
  records: ExamOfficeRecord[];
  total: number;
  page: number;
  pageSize: number;
  semesters: { id: string; name: string; academicYear: { name: string } }[];
  departments: { id: string; name: string }[];
  courses: { id: string; name: string; code: string }[];
}) {
  const table = useUrlTableState(25);
  const [exporting, setExporting] = useState(false);

  const semesterItems = [
    { value: "all", label: "All semesters" },
    ...semesters.map((s) => ({
      value: s.id,
      label: `${s.name} (${s.academicYear.name})`,
    })),
  ];
  const departmentItems = [
    { value: "", label: "All faculties" },
    ...departments.map((d) => ({ value: d.id, label: d.name })),
  ];
  const courseItems = [
    { value: "", label: "All courses" },
    ...courses.map((c) => ({
      value: c.id,
      label: `${c.name} (${c.code})`,
      keywords: [c.code],
    })),
  ];

  async function handleExport() {
    setExporting(true);
    try {
      const { base64, fileName } = await exportMissedExamReport({
        q: table.search || undefined,
        semesterId: table.getFilter("semesterId") || undefined,
        departmentId: table.getFilter("departmentId") || undefined,
        courseId: table.getFilter("courseId") || undefined,
        examType: table.getFilter("examType") || undefined,
        reasonType: table.getFilter("reasonType") || undefined,
      });
      downloadBase64(base64, fileName, XLSX_MIME);
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Could not export the report. Please try again.")
      );
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Missed Exam Records"
        description="Read-only, university-wide view of every registered missed/special exam — no approval or scheduling action happens here."
        action={
          <Button variant="outline" onClick={handleExport} disabled={exporting}>
            {exporting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            Export Excel
          </Button>
        }
      />

      <div className="flex flex-wrap gap-3">
        <TableSearchInput
          value={table.search}
          onChange={table.setSearch}
          placeholder="Search by student or course…"
          className="w-full sm:w-72"
        />
        <div className="w-56">
          <Select
            value={table.getFilter("semesterId") || "all"}
            onValueChange={(value) =>
              table.setFilter("semesterId", value === "all" ? "" : (value ?? ""))
            }
            items={semesterItems}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="All semesters" />
            </SelectTrigger>
            <SelectContent>
              {semesterItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-48">
          <SearchableSelect
            value={table.getFilter("departmentId")}
            onValueChange={(value) => table.setFilter("departmentId", value)}
            items={departmentItems}
            placeholder="All faculties"
            searchPlaceholder="Search faculties…"
            className="w-full"
          />
        </div>
        <div className="w-56">
          <SearchableSelect
            value={table.getFilter("courseId")}
            onValueChange={(value) => table.setFilter("courseId", value)}
            items={courseItems}
            placeholder="All courses"
            searchPlaceholder="Search courses…"
            className="w-full"
          />
        </div>
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
              <TableHead>Faculty</TableHead>
              <TableHead>Course</TableHead>
              <TableHead>Class</TableHead>
              <TableHead>Semester</TableHead>
              <TableHead>Exam</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Recorded by</TableHead>
              <TableHead className="text-right">When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {records.map((r, i) => (
              <TableRow key={r.id} className={i % 2 === 1 ? "bg-muted/30" : undefined}>
                <TableCell className="font-medium">
                  {r.student.studentNo} — {r.student.fullName}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {r.assignment.class.program.department.name}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {r.course.name} ({r.course.code})
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatClassLabel(r.assignment.class)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {r.semester.name} ({r.semester.academicYear.name})
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
          pageSizeOptions={[25, 50, 100]}
        />
      </div>
    </div>
  );
}
