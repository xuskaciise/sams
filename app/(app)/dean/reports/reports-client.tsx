"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Download, Loader2 } from "lucide-react";
import type {
  Class,
  Course,
  Lecturer,
  LecturerCourseAssignment,
  Semester,
  AcademicYear,
  Student,
  User,
} from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { TablePagination } from "@/components/ui/table-pagination";
import { getActionErrorMessage } from "@/lib/action-error";
import { downloadBase64 } from "@/lib/download";
import {
  fetchCourseReport,
  fetchClassReport,
  fetchStudentReport,
  exportCourseReport,
  exportClassReport,
  exportStudentReport,
} from "./actions";
import type { getCourseReport, getClassReport, getStudentReport } from "./queries";

type CourseReportData = NonNullable<Awaited<ReturnType<typeof getCourseReport>>>;
type ClassReportData = NonNullable<Awaited<ReturnType<typeof getClassReport>>>;
type StudentReportData = NonNullable<Awaited<ReturnType<typeof getStudentReport>>>;

type LecturerWithUser = Lecturer & { user: User };
type AssignmentRow = LecturerCourseAssignment & {
  lecturer: LecturerWithUser;
  course: Course;
  class: Class;
  semester: Semester & { academicYear: AcademicYear };
};
type SemesterWithYear = Semester & { academicYear: AcademicYear };

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function fmtPct(value: number | null) {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

export function ReportsClient({
  assignments,
  classes,
  semesters,
  students,
  unassigned,
}: {
  assignments: AssignmentRow[];
  classes: Class[];
  semesters: SemesterWithYear[];
  students: Student[];
  unassigned: boolean;
}) {
  if (unassigned) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No faculties assigned yet</CardTitle>
          <CardDescription>
            Contact the administrator to get faculties assigned to your
            account before you can view any reports.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Tabs defaultValue="course">
      <TabsList>
        <TabsTrigger value="course">Per Course</TabsTrigger>
        <TabsTrigger value="class">Per Class</TabsTrigger>
        <TabsTrigger value="student">Per Student</TabsTrigger>
      </TabsList>
      <TabsContent value="course" className="pt-4">
        <CourseReportSection assignments={assignments} />
      </TabsContent>
      <TabsContent value="class" className="pt-4">
        <ClassReportSection classes={classes} semesters={semesters} />
      </TabsContent>
      <TabsContent value="student" className="pt-4">
        <StudentReportSection students={students} />
      </TabsContent>
    </Tabs>
  );
}

function CourseReportSection({ assignments }: { assignments: AssignmentRow[] }) {
  const [assignmentId, setAssignmentId] = useState("");
  const [report, setReport] = useState<CourseReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  async function onSelect(value: string) {
    setAssignmentId(value);
    setReport(null);
    setPage(1);
    if (!value) return;
    setLoading(true);
    try {
      setReport(await fetchCourseReport(value));
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
      const { base64, fileName } = await exportCourseReport(assignmentId);
      downloadBase64(base64, fileName, XLSX_MIME);
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not export that report."));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-80">
          <Label className="mb-1.5 block">Course assignment</Label>
          <SearchableSelect
            value={assignmentId}
            onValueChange={onSelect}
            items={assignments.map((a) => ({
              value: a.id,
              label: `${a.course.name} — ${a.class.name} — ${a.semester.name}`,
              keywords: [a.lecturer.user.fullName],
            }))}
            placeholder="Select a course assignment"
            searchPlaceholder="Search…"
            className="w-full"
          />
        </div>
        {report && (
          <Button variant="outline" onClick={onExport} disabled={exporting}>
            {exporting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            Export to Excel
          </Button>
        )}
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {report && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            {report.assignment.course.name} · {report.assignment.class.name} ·{" "}
            {report.assignment.semester.name} (
            {report.assignment.semester.academicYear.name}) · Lecturer:{" "}
            {report.assignment.lecturer.user.fullName}
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader>
                <CardDescription>Class average</CardDescription>
                <CardTitle>{fmtPct(report.classAverage)}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Top</CardDescription>
                <CardTitle className="text-base">
                  {report.top
                    ? `${report.top.studentName} (${fmtPct(report.top.percentage)})`
                    : "—"}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Lowest</CardDescription>
                <CardTitle className="text-base">
                  {report.lowest
                    ? `${report.lowest.studentName} (${fmtPct(report.lowest.percentage)})`
                    : "—"}
                </CardTitle>
              </CardHeader>
            </Card>
          </div>

          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Student</TableHead>
                  <TableHead className="text-right">Earned</TableHead>
                  <TableHead className="text-right">Possible</TableHead>
                  <TableHead className="text-right">%</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.studentTotals
                  .slice((page - 1) * pageSize, page * pageSize)
                  .map((s, i) => (
                    <TableRow
                      key={s.enrollmentId}
                      className={i % 2 === 1 ? "bg-muted/30" : undefined}
                    >
                      <TableCell className="font-medium">
                        {s.studentName}{" "}
                        <span className="text-muted-foreground">({s.studentNo})</span>
                      </TableCell>
                      <TableCell className="text-right">{s.earned}</TableCell>
                      <TableCell className="text-right">{s.possible}</TableCell>
                      <TableCell className="text-right">{fmtPct(s.percentage)}</TableCell>
                    </TableRow>
                  ))}
                {report.studentTotals.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
                      No active enrollments.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            {report.studentTotals.length > 0 && (
              <TablePagination
                page={page}
                pageSize={pageSize}
                total={report.studentTotals.length}
                onPageChange={setPage}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
              />
            )}
          </div>

          <p className="text-sm font-semibold">Per-assessment breakdown</p>
          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Assessment</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Max</TableHead>
                  <TableHead className="text-right">Graded</TableHead>
                  <TableHead className="text-right">Average</TableHead>
                  <TableHead>Top</TableHead>
                  <TableHead>Lowest</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.breakdown.map((a, i) => (
                  <TableRow
                    key={a.assessmentId}
                    className={i % 2 === 1 ? "bg-muted/30" : undefined}
                  >
                    <TableCell className="font-medium">{a.title}</TableCell>
                    <TableCell>{a.typeName}</TableCell>
                    <TableCell>
                      <Badge variant={a.status === "DRAFT" ? "draft" : "published"}>
                        {a.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{a.maximumMarks}</TableCell>
                    <TableCell className="text-right">{a.gradedCount}</TableCell>
                    <TableCell className="text-right">
                      {a.average !== null ? a.average.toFixed(1) : "—"}
                    </TableCell>
                    <TableCell>
                      {a.top ? `${a.top.studentName} (${a.top.mark})` : "—"}
                    </TableCell>
                    <TableCell>
                      {a.lowest ? `${a.lowest.studentName} (${a.lowest.mark})` : "—"}
                    </TableCell>
                  </TableRow>
                ))}
                {report.breakdown.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground">
                      No assessments yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}

function ClassReportSection({
  classes,
  semesters,
}: {
  classes: Class[];
  semesters: SemesterWithYear[];
}) {
  const [classId, setClassId] = useState("");
  const [semesterId, setSemesterId] = useState("");
  const [report, setReport] = useState<ClassReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  async function load(nextClassId: string, nextSemesterId: string) {
    setReport(null);
    if (!nextClassId || !nextSemesterId) return;
    setLoading(true);
    try {
      setReport(await fetchClassReport(nextClassId, nextSemesterId));
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not load that report."));
    } finally {
      setLoading(false);
    }
  }

  async function onExport() {
    if (!classId || !semesterId) return;
    setExporting(true);
    try {
      const { base64, fileName } = await exportClassReport(classId, semesterId);
      downloadBase64(base64, fileName, XLSX_MIME);
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not export that report."));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-64">
          <Label className="mb-1.5 block">Class</Label>
          <SearchableSelect
            value={classId}
            onValueChange={(value) => {
              setClassId(value);
              load(value, semesterId);
            }}
            items={classes.map((c) => ({ value: c.id, label: c.name }))}
            placeholder="Select a class"
            searchPlaceholder="Search classes…"
            className="w-full"
          />
        </div>
        <div className="w-64">
          <Label className="mb-1.5 block">Semester</Label>
          <Select
            value={semesterId}
            onValueChange={(value) => {
              const next = value ?? "";
              setSemesterId(next);
              load(classId, next);
            }}
            items={semesters.map((s) => ({
              value: s.id,
              label: `${s.name} (${s.academicYear.name})`,
            }))}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a semester" />
            </SelectTrigger>
            <SelectContent>
              {semesters.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name} ({s.academicYear.name})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {report && (
          <Button variant="outline" onClick={onExport} disabled={exporting}>
            {exporting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            Export to Excel
          </Button>
        )}
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {report && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            {report.class.name} · {report.semester.name} (
            {report.semester.academicYear.name})
          </p>
          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Course</TableHead>
                  <TableHead>Lecturer</TableHead>
                  <TableHead className="text-right">Students</TableHead>
                  <TableHead className="text-right">Class average</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.courses.map((c, i) => (
                  <TableRow
                    key={c.assignmentId}
                    className={i % 2 === 1 ? "bg-muted/30" : undefined}
                  >
                    <TableCell className="font-medium">{c.courseName}</TableCell>
                    <TableCell>{c.lecturerName}</TableCell>
                    <TableCell className="text-right">{c.studentCount}</TableCell>
                    <TableCell className="text-right">{fmtPct(c.classAverage)}</TableCell>
                  </TableRow>
                ))}
                {report.courses.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
                      No courses assigned to this class in this semester.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}

function StudentReportSection({ students }: { students: Student[] }) {
  const [studentId, setStudentId] = useState("");
  const [report, setReport] = useState<StudentReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  async function onSelect(value: string) {
    setStudentId(value);
    setReport(null);
    if (!value) return;
    setLoading(true);
    try {
      setReport(await fetchStudentReport(value));
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not load that report."));
    } finally {
      setLoading(false);
    }
  }

  async function onExport() {
    if (!studentId) return;
    setExporting(true);
    try {
      const { base64, fileName } = await exportStudentReport(studentId);
      downloadBase64(base64, fileName, XLSX_MIME);
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not export that report."));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-80">
          <Label className="mb-1.5 block">Student</Label>
          <SearchableSelect
            value={studentId}
            onValueChange={onSelect}
            items={students.map((s) => ({
              value: s.id,
              label: `${s.studentNo} — ${s.fullName}`,
            }))}
            placeholder="Select a student"
            searchPlaceholder="Search by name or student no…"
            className="w-full"
          />
        </div>
        {report && (
          <Button variant="outline" onClick={onExport} disabled={exporting}>
            {exporting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            Export to Excel
          </Button>
        )}
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {report && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            {report.student.fullName} ({report.student.studentNo}) · Current
            class: {report.student.class.name}
          </p>
          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Course</TableHead>
                  <TableHead>Class</TableHead>
                  <TableHead>Semester</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Earned</TableHead>
                  <TableHead className="text-right">Possible</TableHead>
                  <TableHead className="text-right">%</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.history.map((h, i) => (
                  <TableRow
                    key={h.enrollmentId}
                    className={i % 2 === 1 ? "bg-muted/30" : undefined}
                  >
                    <TableCell className="font-medium">{h.courseName}</TableCell>
                    <TableCell>{h.className}</TableCell>
                    <TableCell>{h.semesterName}</TableCell>
                    <TableCell>{h.status}</TableCell>
                    <TableCell className="text-right">{h.earned}</TableCell>
                    <TableCell className="text-right">{h.possible}</TableCell>
                    <TableCell className="text-right">{fmtPct(h.percentage)}</TableCell>
                  </TableRow>
                ))}
                {report.history.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground">
                      No enrollment history.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
