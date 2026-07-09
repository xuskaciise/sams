"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Loader2, MoreHorizontal, Plus, Upload } from "lucide-react";
import type { Course } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BulkImportDialog } from "@/components/admin/bulk-import-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
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
import { TableSearchInput } from "@/components/ui/table-search-input";
import { TablePagination } from "@/components/ui/table-pagination";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { getActionErrorMessage } from "@/lib/action-error";
import { useUrlTableState } from "@/lib/use-url-table-state";
import { courseSchema, type CourseInput } from "./schema";
import {
  createCourse,
  updateCourse,
  deactivateCourse,
  reactivateCourse,
} from "./actions";
import {
  downloadCourseImportTemplate,
  previewCourseImport,
  confirmCourseImport,
} from "./bulk-import-actions";

const IMPORT_COLUMNS = [
  { key: "course_code", label: "Code" },
  { key: "course_name", label: "Name" },
];

const STATUS_ITEMS = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

export function CoursesClient({
  courses,
  total,
  page,
  pageSize,
}: {
  courses: Course[];
  total: number;
  page: number;
  pageSize: number;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Course | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const table = useUrlTableState();

  const form = useForm<CourseInput>({
    resolver: zodResolver(courseSchema),
    defaultValues: { name: "", code: "" },
  });

  function openCreate() {
    setEditing(null);
    form.reset({ name: "", code: "" });
    setDialogOpen(true);
  }

  function openEdit(course: Course) {
    setEditing(course);
    form.reset({ name: course.name, code: course.code });
    setDialogOpen(true);
  }

  async function onSubmit(values: CourseInput) {
    try {
      if (editing) {
        await updateCourse(editing.id, values);
        toast.success("Course updated.");
      } else {
        await createCourse(values);
        toast.success("Course created.");
      }
      setDialogOpen(false);
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(
          error,
          "Something went wrong. That name or code may already be in use."
        )
      );
    }
  }

  async function onToggleActive(course: Course) {
    try {
      if (course.deletedAt) {
        await reactivateCourse(course.id);
        toast.success("Course reactivated.");
      } else {
        await deactivateCourse(course.id);
        toast.success("Course deactivated.");
      }
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Courses"
        description="Manage courses offered across programs."
        action={
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setImportOpen(true)}
              disabled={isPending}
            >
              <Upload className="size-4" />
              Bulk import
            </Button>
            <Button onClick={openCreate} disabled={isPending}>
              {isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              Add course
            </Button>
          </div>
        }
      />

      <BulkImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        title="Bulk import courses"
        description="Upload a spreadsheet to create many courses at once."
        columns={IMPORT_COLUMNS}
        onDownloadTemplate={downloadCourseImportTemplate}
        onPreview={previewCourseImport}
        onConfirm={async (rows, fileName) => {
          const result = await confirmCourseImport(rows, fileName);
          startTransition(() => router.refresh());
          return result;
        }}
      />

      <div className="flex flex-wrap gap-3">
        <TableSearchInput
          value={table.search}
          onChange={table.setSearch}
          placeholder="Search by name or code…"
          className="w-full sm:w-72"
        />
        <div className="w-40">
          <Select
            value={table.getFilter("status") || "all"}
            onValueChange={(value) =>
              table.setFilter("status", value === "all" ? "" : (value ?? ""))
            }
            items={STATUS_ITEMS}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_ITEMS.map((item) => (
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
              <TableHead>Name</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {courses.map((course, i) => (
              <TableRow
                key={course.id}
                className={i % 2 === 1 ? "bg-muted/30" : undefined}
              >
                <TableCell className="font-medium">{course.name}</TableCell>
                <TableCell>{course.code}</TableCell>
                <TableCell>
                  <Badge variant={course.deletedAt ? "outline" : "published"}>
                    {course.deletedAt ? "Inactive" : "Active"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<Button variant="ghost" size="icon-sm" />}
                    >
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openEdit(course)}>
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onToggleActive(course)}>
                        {course.deletedAt ? "Reactivate" : "Deactivate"}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
            {courses.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="text-center text-muted-foreground"
                >
                  No courses match these filters.
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
            <DialogTitle>{editing ? "Edit course" : "Add course"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="flex flex-col gap-4"
            >
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Code</FormLabel>
                    <FormControl>
                      <Input {...field} />
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
                {editing ? "Save changes" : "Create course"}
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
