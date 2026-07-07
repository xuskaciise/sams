"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Loader2, MoreHorizontal, Plus } from "lucide-react";
import type {
  AcademicYear,
  Class,
  ClassCoursePlan,
  Course,
  Lecturer,
  Semester,
  User,
} from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
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
import { semesterSchema, type SemesterInput } from "./schema";
import { createSemester, updateSemester, openSemester } from "./actions";

type SemesterWithYear = Semester & { academicYear: AcademicYear };
type LecturerWithUser = Lecturer & { user: User };
type ClassWithPlan = Class & {
  coursePlans: (ClassCoursePlan & { course: Course })[];
};

function toDateInputValue(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function SemestersClient({
  semesters,
  academicYears,
  classesWithPlans,
  lecturers,
}: {
  semesters: SemesterWithYear[];
  academicYears: AcademicYear[];
  classesWithPlans: ClassWithPlan[];
  lecturers: LecturerWithUser[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SemesterWithYear | null>(null);

  const [wizardSemester, setWizardSemester] = useState<SemesterWithYear | null>(
    null
  );
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [lecturerByCourse, setLecturerByCourse] = useState<
    Record<string, string>
  >({});
  const [opening, setOpening] = useState(false);

  const form = useForm<SemesterInput>({
    resolver: zodResolver(semesterSchema),
    defaultValues: { name: "", academicYearId: "", startDate: "", endDate: "" },
  });

  function openCreate() {
    setEditing(null);
    form.reset({ name: "", academicYearId: "", startDate: "", endDate: "" });
    setDialogOpen(true);
  }

  function openEdit(semester: SemesterWithYear) {
    setEditing(semester);
    form.reset({
      name: semester.name,
      academicYearId: semester.academicYearId,
      startDate: toDateInputValue(semester.startDate),
      endDate: toDateInputValue(semester.endDate),
    });
    setDialogOpen(true);
  }

  async function onSubmit(values: SemesterInput) {
    try {
      if (editing) {
        await updateSemester(editing.id, values);
        toast.success("Semester updated.");
      } else {
        await createSemester(values);
        toast.success("Semester created.");
      }
      setDialogOpen(false);
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(
          error,
          "Something went wrong. That name may already exist in this academic year."
        )
      );
    }
  }

  function openWizard(semester: SemesterWithYear) {
    setWizardSemester(semester);
    setIncluded(
      Object.fromEntries(classesWithPlans.map((c) => [c.id, true]))
    );
    setLecturerByCourse({});
  }

  function courseKey(classId: string, courseId: string) {
    return `${classId}:${courseId}`;
  }

  function isReadyToSubmit() {
    return classesWithPlans
      .filter((c) => included[c.id])
      .every((c) =>
        c.coursePlans.every(
          (plan) => !!lecturerByCourse[courseKey(c.id, plan.courseId)]
        )
      );
  }

  async function onOpenSemester() {
    if (!wizardSemester) return;
    const selections = classesWithPlans
      .filter((c) => included[c.id])
      .map((c) => ({
        classId: c.id,
        courses: c.coursePlans.map((plan) => ({
          courseId: plan.courseId,
          lecturerId: lecturerByCourse[courseKey(c.id, plan.courseId)] ?? "",
        })),
      }));

    setOpening(true);
    try {
      await openSemester({ semesterId: wizardSemester.id, selections });
      toast.success(`${wizardSemester.name} opened.`);
      setWizardSemester(null);
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    } finally {
      setOpening(false);
    }
  }

  const otherActiveSemesters = wizardSemester
    ? semesters.filter((s) => s.isActive && s.id !== wizardSemester.id)
    : [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Semesters"
        description="Manage semesters within academic years."
        action={
          <Button onClick={openCreate} disabled={isPending}>
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Add semester
          </Button>
        }
      />

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Academic year</TableHead>
              <TableHead>Start date</TableHead>
              <TableHead>End date</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {semesters.map((semester, i) => (
              <TableRow
                key={semester.id}
                className={i % 2 === 1 ? "bg-muted/30" : undefined}
              >
                <TableCell className="font-medium">{semester.name}</TableCell>
                <TableCell>{semester.academicYear.name}</TableCell>
                <TableCell>{semester.startDate.toLocaleDateString()}</TableCell>
                <TableCell>{semester.endDate.toLocaleDateString()}</TableCell>
                <TableCell className="flex gap-1.5">
                  {semester.isActive && (
                    <Badge variant="published">Active</Badge>
                  )}
                  {semester.isClosed && (
                    <Badge variant="outline">Closed</Badge>
                  )}
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
                        disabled={semester.isClosed}
                        onClick={() => openEdit(semester)}
                      >
                        Edit
                      </DropdownMenuItem>
                      {!semester.isActive && (
                        <DropdownMenuItem
                          disabled={semester.isClosed}
                          onClick={() => openWizard(semester)}
                        >
                          Open semester
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
            {semesters.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-muted-foreground"
                >
                  No semesters yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit semester" : "Add semester"}
            </DialogTitle>
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
                      <Input placeholder="e.g. Semester 1" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="academicYearId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Academic year</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      items={academicYears.map((year) => ({
                        value: year.id,
                        label: year.name,
                      }))}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select an academic year" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {academicYears.map((year) => (
                          <SelectItem key={year.id} value={year.id}>
                            {year.name}
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
                name="startDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Start date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="endDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>End date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
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
                {editing ? "Save changes" : "Create semester"}
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!wizardSemester}
        onOpenChange={(open) => !open && setWizardSemester(null)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Open {wizardSemester?.name}</DialogTitle>
            <DialogDescription>
              Create this semester&apos;s course assignments from each
              class&apos;s course plan, and auto-enroll their students.
              Uncheck a class if it isn&apos;t running this semester.
            </DialogDescription>
          </DialogHeader>

          {otherActiveSemesters.length > 0 && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              Opening this semester will deactivate:{" "}
              {otherActiveSemesters.map((s) => s.name).join(", ")}.
            </div>
          )}

          <div className="flex max-h-96 flex-col gap-4 overflow-y-auto">
            {classesWithPlans.map((cls) => (
              <div key={cls.id} className="rounded-lg border border-border p-3">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`class-${cls.id}`}
                    checked={included[cls.id] ?? false}
                    onCheckedChange={(checked) =>
                      setIncluded((prev) => ({
                        ...prev,
                        [cls.id]: checked === true,
                      }))
                    }
                  />
                  <Label htmlFor={`class-${cls.id}`} className="font-semibold">
                    {cls.name}
                  </Label>
                </div>

                {included[cls.id] && (
                  <div className="mt-3 flex flex-col gap-2 pl-6">
                    {cls.coursePlans.map((plan) => (
                      <div
                        key={plan.id}
                        className="flex items-center justify-between gap-3"
                      >
                        <span className="text-sm">{plan.course.name}</span>
                        <div className="w-56">
                          <Select
                            value={
                              lecturerByCourse[
                                courseKey(cls.id, plan.courseId)
                              ] ?? ""
                            }
                            onValueChange={(value) =>
                              setLecturerByCourse((prev) => ({
                                ...prev,
                                [courseKey(cls.id, plan.courseId)]: value ?? "",
                              }))
                            }
                            items={lecturers.map((l) => ({
                              value: l.id,
                              label: l.user.fullName,
                            }))}
                          >
                            <SelectTrigger className="w-full" size="sm">
                              <SelectValue placeholder="Select a lecturer" />
                            </SelectTrigger>
                            <SelectContent>
                              {lecturers.map((l) => (
                                <SelectItem key={l.id} value={l.id}>
                                  {l.user.fullName}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {classesWithPlans.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No class has a course plan yet. Set one up on the Course
                Plans page first.
              </p>
            )}
          </div>

          <Button
            onClick={onOpenSemester}
            disabled={opening || !isReadyToSubmit()}
          >
            {opening ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Open semester"
            )}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
