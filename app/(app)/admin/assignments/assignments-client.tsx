"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Layers, Loader2, Plus, Trash2 } from "lucide-react";
import type {
  AcademicYear,
  Class,
  ClassCoursePlan,
  Course,
  Lecturer,
  LecturerCourseAssignment,
  Semester,
  User,
} from "@prisma/client";
import { Button } from "@/components/ui/button";
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { TablePagination } from "@/components/ui/table-pagination";
import { TableSearchInput } from "@/components/ui/table-search-input";
import { PageHeader } from "@/components/layout/page-header";
import { getActionErrorMessage } from "@/lib/action-error";
import { useUrlTableState } from "@/lib/use-url-table-state";
import { assignmentSchema, type AssignmentInput } from "./schema";
import {
  createAssignment,
  deleteAssignment,
  bulkCreateAssignments,
  type BulkAssignmentResult,
} from "./actions";
import { ALL_SEMESTERS_VALUE } from "./panel";

type SemesterWithYear = Semester & { academicYear: AcademicYear };

type AssignmentRow = LecturerCourseAssignment & {
  lecturer: Lecturer & { user: User };
  course: Course;
  class: Class;
  semester: Semester;
};

type LecturerWithUser = Lecturer & { user: User };
type ClassWithPlan = Class & {
  coursePlans: (ClassCoursePlan & { course: Course })[];
};

type LecturerFirstRow = { courseId: string; classId: string };
type ClassFirstRow = { courseId: string; lecturerId: string };

const ALL_VALUE = "";

export function AssignmentsClient({
  assignments,
  total,
  page,
  pageSize,
  lecturers,
  courses,
  classesWithPlans,
  semesters,
  activeSemesterId,
}: {
  assignments: AssignmentRow[];
  total: number;
  page: number;
  pageSize: number;
  lecturers: LecturerWithUser[];
  courses: Course[];
  classesWithPlans: ClassWithPlan[];
  semesters: SemesterWithYear[];
  activeSemesterId: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);
  const table = useUrlTableState();

  const openSemesters = semesters.filter((s) => !s.isClosed);
  const selectedSemesterId = table.getFilter("semesterId") || activeSemesterId;

  const form = useForm<AssignmentInput>({
    resolver: zodResolver(assignmentSchema),
    defaultValues: { lecturerId: "", courseId: "", classId: "", semesterId: "" },
  });

  function openCreate() {
    form.reset({ lecturerId: "", courseId: "", classId: "", semesterId: "" });
    setDialogOpen(true);
  }

  // Course pickers are always scoped to the selected class's
  // ClassCoursePlan at that class's CURRENT semester level (never +1 —
  // these forms are for the semester already running, not for advancing
  // a class the way the Open Semester wizard does), and exclude any
  // course that already has a lecturer for the selected semester (the
  // one-lecturer-per-course+class+semester rule). Also defensively
  // deduped by name: there are genuine duplicate Course rows in the data
  // today (same name, different ids) — a plan should never reference
  // both for one class+level, but this guarantees the dropdown can never
  // show the same name twice regardless of that underlying data issue.
  function plansForClass(classId: string) {
    const cls = classesWithPlans.find((c) => c.id === classId);
    if (!cls || cls.currentSemesterNumber === null) return [];
    return cls.coursePlans.filter(
      (p) => p.semesterNumber === cls.currentSemesterNumber
    );
  }

  function assignedCourseIds(classId: string, semesterId: string) {
    if (!classId || !semesterId) return new Set<string>();
    return new Set(
      assignments
        .filter((a) => a.classId === classId && a.semesterId === semesterId)
        .map((a) => a.courseId)
    );
  }

  function courseOptionsForClass(classId: string, semesterId: string) {
    const assigned = assignedCourseIds(classId, semesterId);
    const seenNames = new Set<string>();
    const items: { value: string; label: string }[] = [];
    for (const plan of plansForClass(classId)) {
      if (assigned.has(plan.courseId)) continue;
      const key = plan.course.name.trim().toLowerCase();
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      items.push({ value: plan.courseId, label: plan.course.name });
    }
    return items;
  }

  function courseEmptyMessage(classId: string, semesterId: string) {
    if (!classId) return "Select a class first";
    const cls = classesWithPlans.find((c) => c.id === classId);
    if (!cls || cls.currentSemesterNumber === null) {
      return "This class has no semester level set yet.";
    }
    if (plansForClass(classId).length === 0) {
      return "No courses planned for this class's current level.";
    }
    if (semesterId && courseOptionsForClass(classId, semesterId).length === 0) {
      return "Every planned course already has a lecturer this semester.";
    }
    return "No results found.";
  }

  // Bulk assign (mid-semester / ad-hoc) — the Open Semester wizard remains
  // the main tool; this covers one-off exceptions. Two entry directions
  // that both flatten to the same {lecturerId, courseId, classId} rows the
  // server expects.
  const [bulkOpen, setBulkOpen] = useState(false);
  const [direction, setDirection] = useState<"lecturer" | "class">("lecturer");
  const [bulkSemesterId, setBulkSemesterId] = useState("");
  const [bulkLecturerId, setBulkLecturerId] = useState("");
  const [bulkClassId, setBulkClassId] = useState("");
  const [lecturerRows, setLecturerRows] = useState<LecturerFirstRow[]>([
    { courseId: "", classId: "" },
  ]);
  const [classRows, setClassRows] = useState<ClassFirstRow[]>([
    { courseId: "", lecturerId: "" },
  ]);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkAssignmentResult | null>(null);

  function openBulk() {
    setDirection("lecturer");
    setBulkSemesterId(activeSemesterId);
    setBulkLecturerId("");
    setBulkClassId("");
    setLecturerRows([{ courseId: "", classId: "" }]);
    setClassRows([{ courseId: "", lecturerId: "" }]);
    setBulkResult(null);
    setBulkOpen(true);
  }

  function updateLecturerRow(index: number, patch: Partial<LecturerFirstRow>) {
    setLecturerRows((rows) =>
      rows.map((r, i) => (i === index ? { ...r, ...patch } : r))
    );
  }
  function updateClassRow(index: number, patch: Partial<ClassFirstRow>) {
    setClassRows((rows) =>
      rows.map((r, i) => (i === index ? { ...r, ...patch } : r))
    );
  }

  function bulkRows(): { lecturerId: string; courseId: string; classId: string }[] {
    if (direction === "lecturer") {
      return lecturerRows
        .filter((r) => r.courseId && r.classId)
        .map((r) => ({ lecturerId: bulkLecturerId, courseId: r.courseId, classId: r.classId }));
    }
    return classRows
      .filter((r) => r.courseId && r.lecturerId)
      .map((r) => ({ lecturerId: r.lecturerId, courseId: r.courseId, classId: bulkClassId }));
  }

  function isBulkReady() {
    if (!bulkSemesterId) return false;
    if (direction === "lecturer" && !bulkLecturerId) return false;
    if (direction === "class" && !bulkClassId) return false;
    return bulkRows().length > 0;
  }

  async function onBulkSubmit() {
    const rows = bulkRows();
    setBulkSubmitting(true);
    try {
      const result = await bulkCreateAssignments({ semesterId: bulkSemesterId, rows });
      setBulkResult(result);
      if (result.created > 0) {
        startTransition(() => router.refresh());
      }
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    } finally {
      setBulkSubmitting(false);
    }
  }

  function courseName(id: string) {
    return courses.find((c) => c.id === id)?.name ?? id;
  }
  function className(id: string) {
    return classesWithPlans.find((c) => c.id === id)?.name ?? id;
  }
  function lecturerName(id: string) {
    return lecturers.find((l) => l.id === id)?.user.fullName ?? id;
  }

  async function onSubmit(values: AssignmentInput) {
    try {
      await createAssignment(values);
      toast.success("Assignment created.");
      setDialogOpen(false);
      startTransition(() => router.refresh());
    } catch (error) {
      if (error instanceof Error && error.message.includes("already has a lecturer")) {
        toast.error(error.message);
      } else {
        toast.error(
          getActionErrorMessage(error, "Something went wrong. Please try again.")
        );
      }
    }
  }

  async function onDelete(assignment: AssignmentRow) {
    if (!window.confirm("Remove this assignment?")) return;
    try {
      await deleteAssignment(assignment.id);
      toast.success("Assignment removed.");
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(
          error,
          "Could not remove this assignment — it may already have assessments linked to it."
        )
      );
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Lecturer Course Assignments"
        description="Assign lecturers to teach a course for a class and semester."
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={openBulk} disabled={isPending}>
              <Layers className="size-4" />
              Bulk assign
            </Button>
            <Button onClick={openCreate} disabled={isPending}>
              {isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              Add assignment
            </Button>
          </div>
        }
      />

      <div className="flex flex-col gap-3">
        <TableSearchInput
          value={table.search}
          onChange={table.setSearch}
          placeholder="Search by course, class, or lecturer…"
          className="w-full sm:w-80"
        />
        <div className="flex flex-wrap gap-2">
          <div className="w-44">
            <SearchableSelect
              value={table.getFilter("classId") || ALL_VALUE}
              onValueChange={(value) => table.setFilter("classId", value)}
              items={[
                { value: ALL_VALUE, label: "All classes" },
                ...classesWithPlans.map((cls) => ({ value: cls.id, label: cls.name })),
              ]}
              placeholder="Class"
              searchPlaceholder="Search classes…"
              className="w-full"
            />
          </div>
          <div className="w-44">
            <SearchableSelect
              value={table.getFilter("courseId") || ALL_VALUE}
              onValueChange={(value) => table.setFilter("courseId", value)}
              items={[
                { value: ALL_VALUE, label: "All courses" },
                ...courses.map((course) => ({ value: course.id, label: course.name })),
              ]}
              placeholder="Course"
              searchPlaceholder="Search courses…"
              className="w-full"
            />
          </div>
          <div className="w-44">
            <SearchableSelect
              value={table.getFilter("lecturerId") || ALL_VALUE}
              onValueChange={(value) => table.setFilter("lecturerId", value)}
              items={[
                { value: ALL_VALUE, label: "All lecturers" },
                ...lecturers.map((lecturer) => ({
                  value: lecturer.id,
                  label: lecturer.user.fullName,
                })),
              ]}
              placeholder="Lecturer"
              searchPlaceholder="Search lecturers…"
              className="w-full"
            />
          </div>
          <div className="w-52">
            <SearchableSelect
              value={selectedSemesterId || ALL_SEMESTERS_VALUE}
              onValueChange={(value) => table.setFilter("semesterId", value)}
              items={[
                { value: ALL_SEMESTERS_VALUE, label: "All semesters" },
                ...semesters.map((semester) => ({
                  value: semester.id,
                  label: `${semester.name} (${semester.academicYear.name})${semester.isActive ? " — active" : ""}`,
                })),
              ]}
              placeholder="Semester"
              searchPlaceholder="Search semesters…"
              className="w-full"
            />
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Lecturer</TableHead>
              <TableHead>Course</TableHead>
              <TableHead>Class</TableHead>
              <TableHead>Semester</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {assignments.map((a, i) => (
              <TableRow key={a.id} className={i % 2 === 1 ? "bg-muted/30" : undefined}>
                <TableCell className="font-medium">
                  {a.lecturer.user.fullName}
                </TableCell>
                <TableCell>{a.course.name}</TableCell>
                <TableCell>{a.class.name}</TableCell>
                <TableCell>{a.semester.name}</TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onDelete(a)}
                  >
                    <Trash2 className="size-4" />
                    <span className="sr-only">Remove</span>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {assignments.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center text-muted-foreground"
                >
                  No assignments match these filters.
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add assignment</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="flex flex-col gap-4"
            >
              <FormField
                control={form.control}
                name="classId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Class</FormLabel>
                    <SearchableSelect
                      value={field.value}
                      onValueChange={(value) => {
                        field.onChange(value);
                        // The available course list depends on the class —
                        // any previously-picked course may no longer be
                        // valid, so don't leave a stale selection in place.
                        form.setValue("courseId", "");
                      }}
                      items={classesWithPlans.map((cls) => ({
                        value: cls.id,
                        label: cls.name,
                      }))}
                      placeholder="Select a class"
                      searchPlaceholder="Search classes…"
                      className="w-full"
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="semesterId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Semester</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={(value) => {
                        field.onChange(value);
                        // Which courses are "already assigned" depends on
                        // the semester too.
                        form.setValue("courseId", "");
                      }}
                      items={openSemesters.map((semester) => ({
                        value: semester.id,
                        label: semester.name,
                      }))}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select a semester" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {openSemesters.map((semester) => (
                          <SelectItem key={semester.id} value={semester.id}>
                            {semester.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="courseId"
                render={({ field }) => {
                  const classId = form.watch("classId");
                  const semesterId = form.watch("semesterId");
                  return (
                    <FormItem>
                      <FormLabel>Course</FormLabel>
                      <SearchableSelect
                        value={field.value}
                        onValueChange={field.onChange}
                        items={courseOptionsForClass(classId, semesterId)}
                        placeholder={classId ? "Select a course" : "Select a class first"}
                        searchPlaceholder="Search courses…"
                        emptyMessage={courseEmptyMessage(classId, semesterId)}
                        disabled={!classId}
                        className="w-full"
                      />
                      <FormMessage />
                    </FormItem>
                  );
                }}
              />
              <FormField
                control={form.control}
                name="lecturerId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Lecturer</FormLabel>
                    <SearchableSelect
                      value={field.value}
                      onValueChange={field.onChange}
                      items={lecturers.map((lecturer) => ({
                        value: lecturer.id,
                        label: lecturer.user.fullName,
                      }))}
                      placeholder="Select a lecturer"
                      searchPlaceholder="Search lecturers…"
                      className="w-full"
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button
                type="submit"
                disabled={form.formState.isSubmitting}
                className="mt-2"
              >
                Create assignment
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={bulkOpen}
        onOpenChange={(open) => {
          setBulkOpen(open);
          if (!open) setBulkResult(null);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Bulk assign</DialogTitle>
            <DialogDescription>
              Mid-semester and ad-hoc assignments — the Open Semester wizard
              is still the main way to set up a new semester.
            </DialogDescription>
          </DialogHeader>

          {!bulkResult ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label>Semester</Label>
                <Select
                  value={bulkSemesterId}
                  onValueChange={(value) => {
                    setBulkSemesterId(value ?? "");
                    // Which courses count as "already assigned" depends on
                    // the semester — clear stale course picks in every row
                    // rather than silently keep one that's now hidden.
                    setLecturerRows((rows) => rows.map((r) => ({ ...r, courseId: "" })));
                    setClassRows((rows) => rows.map((r) => ({ ...r, courseId: "" })));
                  }}
                  items={openSemesters.map((semester) => ({
                    value: semester.id,
                    label: semester.name,
                  }))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a semester" />
                  </SelectTrigger>
                  <SelectContent>
                    {openSemesters.map((semester) => (
                      <SelectItem key={semester.id} value={semester.id}>
                        {semester.name}
                        {semester.isActive ? " (active)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Tabs
                value={direction}
                onValueChange={(value) => setDirection(value as "lecturer" | "class")}
              >
                <TabsList>
                  <TabsTrigger value="lecturer">One lecturer, many classes</TabsTrigger>
                  <TabsTrigger value="class">One class, many lecturers</TabsTrigger>
                </TabsList>

                <TabsContent value="lecturer" className="flex flex-col gap-3 pt-3">
                  <div className="flex flex-col gap-1.5">
                    <Label>Lecturer</Label>
                    <SearchableSelect
                      value={bulkLecturerId}
                      onValueChange={setBulkLecturerId}
                      items={lecturers.map((lecturer) => ({
                        value: lecturer.id,
                        label: lecturer.user.fullName,
                      }))}
                      placeholder="Select a lecturer"
                      searchPlaceholder="Search lecturers…"
                      className="w-full"
                    />
                  </div>
                  <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
                    {lecturerRows.map((row, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-2 rounded-lg border border-border p-2.5"
                      >
                        <span className="w-4 shrink-0 text-center text-xs text-muted-foreground">
                          {i + 1}
                        </span>
                        <SearchableSelect
                          value={row.classId}
                          onValueChange={(value) =>
                            // Class picked first — the course list below
                            // depends on it, so any stale course pick for
                            // this row must be cleared too.
                            updateLecturerRow(i, { classId: value, courseId: "" })
                          }
                          items={classesWithPlans.map((c) => ({ value: c.id, label: c.name }))}
                          placeholder="Class"
                          searchPlaceholder="Search classes…"
                          className="w-full flex-1"
                        />
                        <SearchableSelect
                          value={row.courseId}
                          onValueChange={(value) => updateLecturerRow(i, { courseId: value })}
                          items={courseOptionsForClass(row.classId, bulkSemesterId)}
                          placeholder={row.classId ? "Course" : "Select a class first"}
                          searchPlaceholder="Search courses…"
                          emptyMessage={courseEmptyMessage(row.classId, bulkSemesterId)}
                          disabled={!row.classId}
                          className="w-full flex-1"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={lecturerRows.length === 1}
                          onClick={() =>
                            setLecturerRows((rows) => rows.filter((_, idx) => idx !== i))
                          }
                        >
                          <Trash2 className="size-4" />
                          <span className="sr-only">Remove row</span>
                        </Button>
                      </div>
                    ))}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="self-start"
                    onClick={() =>
                      setLecturerRows((rows) => [...rows, { courseId: "", classId: "" }])
                    }
                  >
                    <Plus className="size-4" />
                    Add row
                  </Button>
                </TabsContent>

                <TabsContent value="class" className="flex flex-col gap-3 pt-3">
                  <div className="flex flex-col gap-1.5">
                    <Label>Class</Label>
                    <SearchableSelect
                      value={bulkClassId}
                      onValueChange={(value) => {
                        setBulkClassId(value);
                        // Every row's course list depends on this one class
                        // — clear stale picks rather than leave invalid ones.
                        setClassRows((rows) => rows.map((r) => ({ ...r, courseId: "" })));
                      }}
                      items={classesWithPlans.map((c) => ({ value: c.id, label: c.name }))}
                      placeholder="Select a class"
                      searchPlaceholder="Search classes…"
                      className="w-full"
                    />
                  </div>
                  <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
                    {classRows.map((row, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-2 rounded-lg border border-border p-2.5"
                      >
                        <span className="w-4 shrink-0 text-center text-xs text-muted-foreground">
                          {i + 1}
                        </span>
                        <SearchableSelect
                          value={row.courseId}
                          onValueChange={(value) => updateClassRow(i, { courseId: value })}
                          items={courseOptionsForClass(bulkClassId, bulkSemesterId)}
                          placeholder={bulkClassId ? "Course" : "Select a class first"}
                          searchPlaceholder="Search courses…"
                          emptyMessage={courseEmptyMessage(bulkClassId, bulkSemesterId)}
                          disabled={!bulkClassId}
                          className="w-full flex-1"
                        />
                        <SearchableSelect
                          value={row.lecturerId}
                          onValueChange={(value) => updateClassRow(i, { lecturerId: value })}
                          items={lecturers.map((l) => ({ value: l.id, label: l.user.fullName }))}
                          placeholder="Lecturer"
                          searchPlaceholder="Search lecturers…"
                          className="w-full flex-1"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={classRows.length === 1}
                          onClick={() =>
                            setClassRows((rows) => rows.filter((_, idx) => idx !== i))
                          }
                        >
                          <Trash2 className="size-4" />
                          <span className="sr-only">Remove row</span>
                        </Button>
                      </div>
                    ))}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="self-start"
                    onClick={() =>
                      setClassRows((rows) => [...rows, { courseId: "", lecturerId: "" }])
                    }
                  >
                    <Plus className="size-4" />
                    Add row
                  </Button>
                </TabsContent>
              </Tabs>

              <Button
                onClick={onBulkSubmit}
                disabled={!isBulkReady() || bulkSubmitting}
                className="mt-2"
              >
                {bulkSubmitting && <Loader2 className="size-4 animate-spin" />}
                Assign{bulkRows().length > 0 ? ` (${bulkRows().length})` : ""}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm">
                <strong>{bulkResult.created}</strong> created,{" "}
                <strong>{bulkResult.skipped}</strong> skipped.
              </p>
              <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
                {bulkResult.results.map((r, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border p-2.5 text-sm"
                  >
                    <span className="truncate">
                      {courseName(r.courseId)} · {className(r.classId)} ·{" "}
                      {lecturerName(r.lecturerId)}
                    </span>
                    {r.status === "created" ? (
                      <Badge variant="published">Created</Badge>
                    ) : (
                      <span className="flex shrink-0 items-center gap-1.5">
                        <Badge variant="outline">Skipped</Badge>
                        <span className="text-xs text-muted-foreground">{r.reason}</span>
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <Button onClick={() => setBulkOpen(false)} className="mt-2">
                Done
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
