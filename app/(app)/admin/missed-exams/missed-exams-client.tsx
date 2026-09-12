"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
import type { MissedExamType, MissedExamReasonType } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
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
import {
  missedExamRecordSchema,
  type MissedExamRecordInput,
} from "./schema";
import { recordMissedExam, getStudentExamOptionsAction } from "./actions";
import type { StudentExamOption } from "./queries";

interface RecordRow {
  id: string;
  examType: MissedExamType;
  reasonType: MissedExamReasonType;
  reasonNote: string | null;
  recordedAt: Date;
  student: { studentNo: string; fullName: string };
  course: { name: string; code: string };
  assignment: { class: { name: string; currentSemesterNumber: number | null } };
  semester: { name: string; academicYear: { name: string } };
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

const ERROR_MESSAGES: Record<string, string> = {
  STUDENT_NOT_FOUND: "That student isn't available to you.",
  ASSIGNMENT_NOT_FOUND: "That course isn't available to you.",
  NOT_ENROLLED: "That student isn't actively enrolled in that course.",
};

function studentLabel(student: { studentNo: string; fullName: string }): string {
  return `${student.studentNo} — ${student.fullName}`;
}

function emptyValues(): MissedExamRecordInput {
  return {
    studentId: "",
    assignmentId: "",
    examType: "MIDTERM",
    reasonType: "ILLNESS",
    reasonNote: "",
  };
}

export function MissedExamsClient({
  records,
  total,
  page,
  pageSize,
  students,
  unassigned,
}: {
  records: RecordRow[];
  total: number;
  page: number;
  pageSize: number;
  students: { id: string; studentNo: string; fullName: string }[];
  unassigned: boolean;
}) {
  const router = useRouter();
  const table = useUrlTableState();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [courseOptions, setCourseOptions] = useState<StudentExamOption[]>([]);
  const [loadingCourses, setLoadingCourses] = useState(false);

  const form = useForm<MissedExamRecordInput>({
    resolver: zodResolver(missedExamRecordSchema),
    defaultValues: emptyValues(),
  });
  const studentId = form.watch("studentId");

  useEffect(() => {
    if (!studentId) {
      setCourseOptions([]);
      return;
    }
    let cancelled = false;
    form.setValue("assignmentId", "");
    setLoadingCourses(true);
    getStudentExamOptionsAction(studentId)
      .then((opts) => {
        if (!cancelled) setCourseOptions(opts);
      })
      .catch(() => {
        if (!cancelled) setCourseOptions([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingCourses(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- form is stable; re-run only when the picked student changes
  }, [studentId]);

  function openAdd() {
    form.reset(emptyValues());
    setCourseOptions([]);
    setDialogOpen(true);
  }

  async function onSubmit(values: MissedExamRecordInput) {
    try {
      await recordMissedExam(values);
      toast.success("Missed exam recorded.");
      setDialogOpen(false);
      router.refresh();
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      toast.error(
        ERROR_MESSAGES[code] ??
          getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    }
  }

  const studentItems = students.map((s) => ({
    value: s.id,
    label: studentLabel(s),
    keywords: [s.studentNo, s.fullName],
  }));
  const courseItems = courseOptions.map((c) => ({
    value: c.assignmentId,
    label: `${c.courseName} (${c.courseCode}) — ${c.className}`,
    keywords: [c.courseName, c.courseCode, c.className, c.semesterName],
  }));

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
        description="Register why a student missed a midterm/final exam — no connection to grading or assessment content."
        action={
          <Button onClick={openAdd}>
            <Plus className="size-4" />
            Record missed exam
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
                  {studentLabel(r.student)}
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

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Record missed exam</DialogTitle>
            <DialogDescription>
              Log why a student missed a midterm/final exam. This does not
              affect assessments, marks, or results.
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
              <FormField
                control={form.control}
                name="studentId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Student</FormLabel>
                    <SearchableSelect
                      value={field.value}
                      onValueChange={field.onChange}
                      items={studentItems}
                      placeholder="Select a student"
                      searchPlaceholder="Search students…"
                      className="w-full"
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="assignmentId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Course</FormLabel>
                    <SearchableSelect
                      value={field.value}
                      onValueChange={field.onChange}
                      items={courseItems}
                      placeholder={
                        !studentId
                          ? "Select a student first"
                          : loadingCourses
                            ? "Loading…"
                            : "Select a course"
                      }
                      searchPlaceholder="Search courses…"
                      emptyMessage={
                        studentId && !loadingCourses
                          ? "This student has no active enrollments available to you."
                          : undefined
                      }
                      disabled={!studentId || loadingCourses}
                      className="w-full"
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="examType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Exam type</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="MIDTERM">Midterm</SelectItem>
                        <SelectItem value="FINAL">Final</SelectItem>
                        <SelectItem value="BOTH">Both</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="reasonType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Reason</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="ILLNESS">Illness</SelectItem>
                        <SelectItem value="CHEATING">Cheating</SelectItem>
                        <SelectItem value="EMERGENCY">Emergency</SelectItem>
                        <SelectItem value="OTHER">Other</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="reasonNote"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Note (optional)</FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        placeholder="Any additional detail…"
                        rows={3}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting && (
                  <Loader2 className="size-4 animate-spin" />
                )}
                Save
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
