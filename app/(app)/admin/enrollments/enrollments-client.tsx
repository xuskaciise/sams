"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Loader2, MoreHorizontal, Plus } from "lucide-react";
import type {
  Class,
  Course,
  Semester,
  Student,
  StudentCourseEnrollment,
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
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { getActionErrorMessage } from "@/lib/action-error";
import {
  enrollmentSchema,
  type EnrollmentInput,
  transferSchema,
  type TransferInput,
} from "./schema";
import { createEnrollment, dropEnrollment, transferEnrollment } from "./actions";

type StudentWithUser = Student & { user: User };

type EnrollmentRow = StudentCourseEnrollment & {
  student: StudentWithUser;
  course: Course;
  class: Class;
  semester: Semester;
};

const STATUS_VARIANT: Record<
  EnrollmentRow["status"],
  "published" | "outline" | "draft" | "secondary"
> = {
  ACTIVE: "published",
  COMPLETED: "secondary",
  TRANSFERRED: "outline",
  DROPPED: "outline",
};

export function EnrollmentsClient({
  enrollments,
  students,
  courses,
  semesters,
  classes,
}: {
  enrollments: EnrollmentRow[];
  students: StudentWithUser[];
  courses: Course[];
  semesters: Semester[];
  classes: Class[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [transferring, setTransferring] = useState<EnrollmentRow | null>(null);

  const form = useForm<EnrollmentInput>({
    resolver: zodResolver(enrollmentSchema),
    defaultValues: { studentId: "", courseId: "", semesterId: "" },
  });

  const transferForm = useForm<TransferInput>({
    resolver: zodResolver(transferSchema),
    defaultValues: { newClassId: "" },
  });

  function openCreate() {
    form.reset({ studentId: "", courseId: "", semesterId: "" });
    setDialogOpen(true);
  }

  function openTransfer(enrollment: EnrollmentRow) {
    transferForm.reset({ newClassId: "" });
    setTransferring(enrollment);
  }

  async function onSubmit(values: EnrollmentInput) {
    try {
      await createEnrollment(values);
      toast.success("Enrollment created.");
      setDialogOpen(false);
      startTransition(() => router.refresh());
    } catch (error) {
      if (error instanceof Error && error.message === "ALREADY_ENROLLED") {
        toast.error(
          "That student is already actively enrolled in this course and semester."
        );
      } else {
        toast.error(
          getActionErrorMessage(error, "Something went wrong. Please try again.")
        );
      }
    }
  }

  async function onDrop(enrollment: EnrollmentRow) {
    try {
      await dropEnrollment(enrollment.id);
      toast.success("Enrollment dropped.");
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    }
  }

  async function onTransferSubmit(values: TransferInput) {
    if (!transferring) return;
    try {
      await transferEnrollment(transferring.id, values);
      toast.success("Student transferred.");
      setTransferring(null);
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
        title="Student Enrollments"
        description="Enroll students in courses, drop, or transfer them between classes."
        action={
          <Button onClick={openCreate} disabled={isPending}>
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Add enrollment
          </Button>
        }
      />

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Student</TableHead>
              <TableHead>Course</TableHead>
              <TableHead>Class</TableHead>
              <TableHead>Semester</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {enrollments.map((e, i) => (
              <TableRow key={e.id} className={i % 2 === 1 ? "bg-muted/30" : undefined}>
                <TableCell className="font-medium">
                  {e.student.user.fullName}{" "}
                  <span className="text-muted-foreground">
                    ({e.student.studentNo})
                  </span>
                </TableCell>
                <TableCell>{e.course.name}</TableCell>
                <TableCell>{e.class.name}</TableCell>
                <TableCell>{e.semester.name}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[e.status]}>{e.status}</Badge>
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<Button variant="ghost" size="icon-sm" />}
                    >
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        disabled={e.status !== "ACTIVE"}
                        onClick={() => openTransfer(e)}
                      >
                        Transfer class
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={e.status !== "ACTIVE"}
                        onClick={() => onDrop(e)}
                      >
                        Drop
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
            {enrollments.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-muted-foreground"
                >
                  No enrollments yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add enrollment</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="flex flex-col gap-4"
            >
              <FormField
                control={form.control}
                name="studentId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Student</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      items={students.map((student) => ({
                        value: student.id,
                        label: `${student.user.fullName} (${student.studentNo})`,
                      }))}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select a student" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {students.map((student) => (
                          <SelectItem key={student.id} value={student.id}>
                            {student.user.fullName} ({student.studentNo})
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
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Course</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      items={courses.map((course) => ({
                        value: course.id,
                        label: course.name,
                      }))}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select a course" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {courses.map((course) => (
                          <SelectItem key={course.id} value={course.id}>
                            {course.name}
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
              <p className="text-sm text-muted-foreground">
                The student is enrolled in their current class automatically.
              </p>
              <Button
                type="submit"
                disabled={form.formState.isSubmitting}
                className="mt-2"
              >
                Create enrollment
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!transferring}
        onOpenChange={(open) => !open && setTransferring(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transfer class</DialogTitle>
          </DialogHeader>
          <Form {...transferForm}>
            <form
              onSubmit={transferForm.handleSubmit(onTransferSubmit)}
              className="flex flex-col gap-4"
            >
              <FormField
                control={transferForm.control}
                name="newClassId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>New class</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      items={classes
                        .filter((cls) => cls.id !== transferring?.classId)
                        .map((cls) => ({ value: cls.id, label: cls.name }))}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select the new class" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {classes
                          .filter((cls) => cls.id !== transferring?.classId)
                          .map((cls) => (
                            <SelectItem key={cls.id} value={cls.id}>
                              {cls.name}
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
                disabled={transferForm.formState.isSubmitting}
                className="mt-2"
              >
                Confirm transfer
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
