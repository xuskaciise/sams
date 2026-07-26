"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Loader2, Plus, CalendarClock } from "lucide-react";
import type {
  DailyLogEntry,
  DailyLogType,
  Department,
  Lecturer,
  Student,
  User,
} from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
import { getActionErrorMessage } from "@/lib/action-error";
import { useUrlTableState } from "@/lib/use-url-table-state";
import { dailyLogEntrySchema, type DailyLogEntryInput } from "./schema";
import { createDailyLogEntry } from "./actions";

type EntryRow = DailyLogEntry & {
  department: Department;
  author: { fullName: string };
  relatedLecturer: { user: { fullName: string } } | null;
  relatedStudent: { studentNo: string; fullName: string } | null;
};
type LecturerWithUser = Lecturer & { user: User };

function studentLabel(student: { studentNo: string; fullName: string }): string {
  return `${student.studentNo} — ${student.fullName}`;
}

const TYPE_ITEMS = [
  { value: "all", label: "All types" },
  { value: "LEAVE_NOTICE", label: "Leave Notice" },
  { value: "PROBLEM", label: "Problem" },
  { value: "NOTE", label: "Note" },
];

const TYPE_BADGE: Record<DailyLogType, { label: string; variant: "draft" | "destructive" | "secondary" }> = {
  LEAVE_NOTICE: { label: "Leave Notice", variant: "draft" },
  PROBLEM: { label: "Problem", variant: "destructive" },
  NOTE: { label: "Note", variant: "secondary" },
};

const ERROR_MESSAGES: Record<string, string> = {
  FORBIDDEN_DEPARTMENT: "That faculty isn't one you oversee.",
  LECTURER_NOT_FOUND: "That lecturer isn't available to you.",
  STUDENT_NOT_FOUND: "That student isn't available to you.",
};

function todayInputValue(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyValues(defaultDepartmentId: string, type: DailyLogType): DailyLogEntryInput {
  return {
    departmentId: defaultDepartmentId,
    type,
    relatedLecturerId: "",
    relatedStudentId: "",
    title: "",
    description: "",
    entryDate: todayInputValue(),
  };
}

type RelatedMode = "LECTURER" | "STUDENT" | "NONE";

// Shared by ALL THREE entry types — the identical "About a lecturer" /
// "About a student" toggle + picker, not duplicated per type.
// LEAVE_NOTICE requires exactly one (allowNone=false, no "Neither"
// button); PROBLEM/NOTE make it fully optional (allowNone=true,
// defaulting to "Neither"). Switching modes clears whichever field just
// stopped being shown, so the two ids are never both set at once — the
// Zod schema enforces the same rule server-side as a backstop.
function RelatedPersonField({
  form,
  mode,
  onModeChange,
  allowNone,
  lecturerItems,
  studentItems,
}: {
  form: UseFormReturn<DailyLogEntryInput>;
  mode: RelatedMode;
  onModeChange: (mode: RelatedMode) => void;
  allowNone: boolean;
  lecturerItems: { value: string; label: string }[];
  studentItems: { value: string; label: string; keywords: string[] }[];
}) {
  function selectMode(next: RelatedMode) {
    if (next !== "LECTURER") form.setValue("relatedLecturerId", "");
    if (next !== "STUDENT") form.setValue("relatedStudentId", "");
    onModeChange(next);
  }

  return (
    <div className="flex flex-col gap-2">
      <Label>{allowNone ? "About (optional)" : "About"}</Label>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant={mode === "LECTURER" ? "default" : "outline"}
          onClick={() => selectMode("LECTURER")}
        >
          About a lecturer
        </Button>
        <Button
          type="button"
          size="sm"
          variant={mode === "STUDENT" ? "default" : "outline"}
          onClick={() => selectMode("STUDENT")}
        >
          About a student
        </Button>
        {allowNone && (
          <Button
            type="button"
            size="sm"
            variant={mode === "NONE" ? "default" : "outline"}
            onClick={() => selectMode("NONE")}
          >
            Neither
          </Button>
        )}
      </div>
      {mode === "LECTURER" && (
        <FormField
          control={form.control}
          name="relatedLecturerId"
          render={({ field }) => (
            <FormItem>
              <SearchableSelect
                value={field.value ?? ""}
                onValueChange={field.onChange}
                items={lecturerItems}
                placeholder="Select a lecturer"
                searchPlaceholder="Search lecturers…"
                className="w-full"
              />
              <FormMessage />
            </FormItem>
          )}
        />
      )}
      {mode === "STUDENT" && (
        <FormField
          control={form.control}
          name="relatedStudentId"
          render={({ field }) => (
            <FormItem>
              <SearchableSelect
                value={field.value ?? ""}
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
      )}
    </div>
  );
}

export function DailyLogClient({
  entries,
  total,
  page,
  pageSize,
  departments,
  lecturers,
  students,
  unassigned,
}: {
  entries: EntryRow[];
  total: number;
  page: number;
  pageSize: number;
  departments: Department[];
  lecturers: LecturerWithUser[];
  students: Student[];
  unassigned: boolean;
}) {
  const router = useRouter();
  const table = useUrlTableState();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [relatedMode, setRelatedMode] = useState<RelatedMode>("NONE");

  const showFacultyPicker = departments.length > 1;
  const form = useForm<DailyLogEntryInput>({
    resolver: zodResolver(dailyLogEntrySchema),
    defaultValues: emptyValues(departments[0]?.id ?? "", "NOTE"),
  });
  const type = form.watch("type");

  function openAddEntry() {
    form.reset(emptyValues(departments[0]?.id ?? "", "NOTE"));
    setRelatedMode("NONE");
    setDialogOpen(true);
  }

  function openQuickLeaveNotice() {
    form.reset(emptyValues(departments[0]?.id ?? "", "LEAVE_NOTICE"));
    setRelatedMode("LECTURER");
    setDialogOpen(true);
  }

  async function onSubmit(values: DailyLogEntryInput) {
    try {
      await createDailyLogEntry(values);
      toast.success("Entry added.");
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

  const typeItems = [
    { value: "LEAVE_NOTICE", label: "Leave Notice" },
    { value: "PROBLEM", label: "Problem" },
    { value: "NOTE", label: "Note" },
  ];
  const departmentItems = departments.map((d) => ({
    value: d.id,
    label: `${d.name} (${d.code})`,
  }));
  const lecturerItems = lecturers.map((l) => ({
    value: l.id,
    label: l.user.fullName,
  }));
  const studentItems = students.map((s) => ({
    value: s.id,
    label: studentLabel(s),
    keywords: [s.studentNo, s.fullName],
  }));

  if (unassigned) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Daily Log"
          description="Notes, leave notices, and problems logged for your faculty."
        />
        <Card>
          <CardHeader>
            <CardTitle>No faculties assigned yet</CardTitle>
            <CardDescription>
              Contact the administrator to get faculties assigned to your
              account before you can log or view entries.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Daily Log"
        description="Notes, leave notices, and problems logged for the faculty."
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={openQuickLeaveNotice}>
              <CalendarClock className="size-4" />
              Quick leave notice
            </Button>
            <Button onClick={openAddEntry}>
              <Plus className="size-4" />
              Add entry
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap gap-3">
        <TableSearchInput
          value={table.search}
          onChange={table.setSearch}
          placeholder="Search by title or description…"
          className="w-full sm:w-72"
        />
        <div className="w-44">
          <Select
            value={table.getFilter("type") || "all"}
            onValueChange={(value) =>
              table.setFilter("type", value === "all" ? "" : (value ?? ""))
            }
            items={TYPE_ITEMS}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              {TYPE_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {showFacultyPicker && (
          <div className="w-56">
            <SearchableSelect
              value={table.getFilter("department")}
              onValueChange={(value) => table.setFilter("department", value)}
              items={departmentItems}
              placeholder="All faculties"
              searchPlaceholder="Search faculties…"
              className="w-full"
            />
          </div>
        )}
        <Input
          type="date"
          value={table.getFilter("date")}
          onChange={(e) => table.setFilter("date", e.target.value)}
          className="w-44"
        />
      </div>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Faculty</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Related</TableHead>
              <TableHead>Logged by</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry, i) => (
              <TableRow
                key={entry.id}
                className={i % 2 === 1 ? "bg-muted/30" : undefined}
              >
                <TableCell className="text-muted-foreground">
                  {entry.entryDate.toLocaleDateString()}
                </TableCell>
                <TableCell>
                  <Badge variant={TYPE_BADGE[entry.type].variant}>
                    {TYPE_BADGE[entry.type].label}
                  </Badge>
                </TableCell>
                <TableCell>{entry.department.name}</TableCell>
                <TableCell className="font-medium">
                  {entry.title}
                  {entry.description && (
                    <p className="mt-0.5 text-xs font-normal text-muted-foreground">
                      {entry.description}
                    </p>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {entry.relatedLecturer?.user.fullName ??
                    (entry.relatedStudent ? studentLabel(entry.relatedStudent) : "—")}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {entry.author.fullName}
                </TableCell>
              </TableRow>
            ))}
            {entries.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  No entries match these filters.
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
            <DialogTitle>
              {type === "LEAVE_NOTICE" ? "Quick leave notice" : "Add entry"}
            </DialogTitle>
            <DialogDescription>
              {type === "LEAVE_NOTICE"
                ? "Pick who this is about, the date, and an optional note."
                : "Log a note or a problem for the faculty."}
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="flex flex-col gap-4"
            >
              <FormField
                control={form.control}
                name="type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={(value) => {
                        field.onChange(value);
                        if (value === "LEAVE_NOTICE" && relatedMode === "NONE") {
                          setRelatedMode("LECTURER");
                        }
                      }}
                      items={typeItems}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select a type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {typeItems.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {showFacultyPicker && (
                <FormField
                  control={form.control}
                  name="departmentId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Faculty</FormLabel>
                      <SearchableSelect
                        value={field.value}
                        onValueChange={field.onChange}
                        items={departmentItems}
                        placeholder="Select a faculty"
                        searchPlaceholder="Search faculties…"
                        className="w-full"
                      />
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {type !== "LEAVE_NOTICE" && (
                <FormField
                  control={form.control}
                  name="title"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Title</FormLabel>
                      <FormControl>
                        <Input placeholder="Short summary" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <RelatedPersonField
                form={form}
                mode={relatedMode}
                onModeChange={setRelatedMode}
                allowNone={type !== "LEAVE_NOTICE"}
                lecturerItems={lecturerItems}
                studentItems={studentItems}
              />

              <FormField
                control={form.control}
                name="entryDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {type === "LEAVE_NOTICE" ? "Note (optional)" : "Description"}
                    </FormLabel>
                    <FormControl>
                      <Textarea rows={3} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button
                type="submit"
                disabled={form.formState.isSubmitting}
                className="mt-2"
              >
                {form.formState.isSubmitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  "Save entry"
                )}
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
