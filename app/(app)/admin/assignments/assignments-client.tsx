"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
import type {
  Class,
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
import { getActionErrorMessage } from "@/lib/action-error";
import { assignmentSchema, type AssignmentInput } from "./schema";
import { createAssignment, deleteAssignment } from "./actions";

type AssignmentRow = LecturerCourseAssignment & {
  lecturer: Lecturer & { user: User };
  course: Course;
  class: Class;
  semester: Semester;
};

type LecturerWithUser = Lecturer & { user: User };

export function AssignmentsClient({
  assignments,
  lecturers,
  courses,
  classes,
  semesters,
}: {
  assignments: AssignmentRow[];
  lecturers: LecturerWithUser[];
  courses: Course[];
  classes: Class[];
  semesters: Semester[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);

  const form = useForm<AssignmentInput>({
    resolver: zodResolver(assignmentSchema),
    defaultValues: { lecturerId: "", courseId: "", classId: "", semesterId: "" },
  });

  function openCreate() {
    form.reset({ lecturerId: "", courseId: "", classId: "", semesterId: "" });
    setDialogOpen(true);
  }

  async function onSubmit(values: AssignmentInput) {
    try {
      await createAssignment(values);
      toast.success("Assignment created.");
      setDialogOpen(false);
      startTransition(() => router.refresh());
    } catch (error) {
      if (error instanceof Error && error.message === "DUPLICATE_ASSIGNMENT") {
        toast.error(
          "That lecturer is already assigned to this course, class, and semester."
        );
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
          <Button onClick={openCreate} disabled={isPending}>
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Add assignment
          </Button>
        }
      />

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
                  No assignments yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
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
              <FormField
                control={form.control}
                name="courseId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Course</FormLabel>
                    <SearchableSelect
                      value={field.value}
                      onValueChange={field.onChange}
                      items={courses.map((course) => ({
                        value: course.id,
                        label: course.name,
                      }))}
                      placeholder="Select a course"
                      searchPlaceholder="Search courses…"
                      className="w-full"
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="classId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Class</FormLabel>
                    <SearchableSelect
                      value={field.value}
                      onValueChange={field.onChange}
                      items={classes.map((cls) => ({
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
                      onValueChange={field.onChange}
                      items={semesters.map((semester) => ({
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
                        {semesters.map((semester) => (
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
    </div>
  );
}
