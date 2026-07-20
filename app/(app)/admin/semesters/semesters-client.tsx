"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { AlertTriangle, Loader2, MoreHorizontal, Plus } from "lucide-react";
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
import { SearchableSelect } from "@/components/ui/searchable-select";
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
import {
  createSemester,
  updateSemester,
  openSemester,
  closeSemester,
} from "./actions";

type SemesterWithYear = Semester & { academicYear: AcademicYear };
type LecturerWithUser = Lecturer & { user: User };
type ClassWithPlan = Class & {
  coursePlans: (ClassCoursePlan & { course: Course })[];
};

const MAX_SEMESTER_NUMBER = 8;

// "" for "not picked yet" — never `undefined`. Base UI's Select decides
// controlled-vs-uncontrolled on first render from whether `value` is
// `undefined`; defaulting this field to `undefined` (even briefly, e.g.
// for a legacy semester with no number yet) flips it from uncontrolled
// to controlled later and throws. The type says "1" | "2" but RHF only
// enforces that through Zod at submit time, not on defaultValues, so the
// cast is safe — submitting "" fails validation same as any other value
// outside the enum.
const UNSET_SEMESTER_NUMBER = "" as SemesterInput["semesterNumber"];

function toDateInputValue(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function courseKey(classId: string, courseId: string) {
  return `${classId}:${courseId}`;
}

export function SemestersClient({
  semesters,
  academicYears,
  classesWithPlans,
  lecturers,
  previousActiveSemester,
  participatingClassIds,
  activeSemesterCounts,
}: {
  semesters: SemesterWithYear[];
  academicYears: AcademicYear[];
  classesWithPlans: ClassWithPlan[];
  lecturers: LecturerWithUser[];
  previousActiveSemester: Semester | null;
  participatingClassIds: string[];
  activeSemesterCounts: { total: number; draft: number; published: number };
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SemesterWithYear | null>(null);

  const [wizardSemester, setWizardSemester] = useState<SemesterWithYear | null>(
    null
  );
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [advanceByClass, setAdvanceByClass] = useState<Record<string, boolean>>(
    {}
  );
  const [lecturerByCourse, setLecturerByCourse] = useState<
    Record<string, string>
  >({});
  const [opening, setOpening] = useState(false);

  const [closeTarget, setCloseTarget] = useState<SemesterWithYear | null>(null);
  const [closing, setClosing] = useState(false);

  const participatingSet = new Set(participatingClassIds);
  const previousNotClosed = !!previousActiveSemester && !previousActiveSemester.isClosed;

  const form = useForm<SemesterInput>({
    resolver: zodResolver(semesterSchema),
    defaultValues: {
      semesterNumber: UNSET_SEMESTER_NUMBER,
      academicYearId: "",
      startDate: "",
      endDate: "",
    },
  });

  function openCreate() {
    setEditing(null);
    form.reset({
      semesterNumber: UNSET_SEMESTER_NUMBER,
      academicYearId: "",
      startDate: "",
      endDate: "",
    });
    setDialogOpen(true);
  }

  function openEdit(semester: SemesterWithYear) {
    setEditing(semester);
    form.reset({
      // Legacy semesters migrated before this field existed may have no
      // number yet — leave it unset so the admin has to explicitly pick
      // one (rather than silently defaulting to "1").
      semesterNumber:
        semester.semesterNumber === 1 || semester.semesterNumber === 2
          ? (String(semester.semesterNumber) as "1" | "2")
          : UNSET_SEMESTER_NUMBER,
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
      if (error instanceof Error && error.message.includes("already has Semester")) {
        toast.error(error.message);
      } else {
        toast.error(
          getActionErrorMessage(error, "Something went wrong. Please try again.")
        );
      }
    }
  }

  function openWizard(semester: SemesterWithYear) {
    setWizardSemester(semester);
    setStep(1);
    setAdvanceByClass(
      Object.fromEntries(
        classesWithPlans.map((c) => [
          c.id,
          participatingSet.has(c.id) &&
            (c.currentSemesterNumber ?? MAX_SEMESTER_NUMBER) < MAX_SEMESTER_NUMBER,
        ])
      )
    );
    setLecturerByCourse({});
  }

  function targetSemesterNumber(cls: ClassWithPlan): number {
    const current = cls.currentSemesterNumber ?? 1;
    return advanceByClass[cls.id] ? current + 1 : current;
  }

  function targetPlans(cls: ClassWithPlan) {
    const target = targetSemesterNumber(cls);
    return cls.coursePlans.filter((p) => p.semesterNumber === target);
  }

  function isStep2Ready() {
    return classesWithPlans.every((cls) =>
      targetPlans(cls).every(
        (plan) => !!lecturerByCourse[courseKey(cls.id, plan.courseId)]
      )
    );
  }

  async function onOpenSemester() {
    if (!wizardSemester) return;
    const classes = classesWithPlans.map((cls) => ({
      classId: cls.id,
      advance: !!advanceByClass[cls.id],
      lecturerByCourse: Object.fromEntries(
        targetPlans(cls).map((plan) => [
          plan.courseId,
          lecturerByCourse[courseKey(cls.id, plan.courseId)] ?? "",
        ])
      ),
    }));

    setOpening(true);
    try {
      await openSemester({ semesterId: wizardSemester.id, classes });
      toast.success(`${wizardSemester.name} opened.`);
      setWizardSemester(null);
      startTransition(() => router.refresh());
    } catch (error) {
      if (error instanceof Error && error.message.includes("already has a lecturer")) {
        toast.error(error.message);
      } else {
        toast.error(
          getActionErrorMessage(error, "Something went wrong. Please try again.")
        );
      }
    } finally {
      setOpening(false);
    }
  }

  async function onConfirmClose() {
    if (!closeTarget) return;
    setClosing(true);
    try {
      await closeSemester(closeTarget.id);
      toast.success(`${closeTarget.name} closed.`);
      setCloseTarget(null);
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    } finally {
      setClosing(false);
    }
  }

  const otherActiveSemesters = wizardSemester
    ? semesters.filter((s) => s.isActive && s.id !== wizardSemester.id)
    : [];

  const advancingCount = classesWithPlans.filter((c) => advanceByClass[c.id]).length;
  const assignmentsCount = classesWithPlans.reduce(
    (sum, cls) => sum + targetPlans(cls).length,
    0
  );

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
                      {semester.isActive && !semester.isClosed && (
                        <DropdownMenuItem onClick={() => setCloseTarget(semester)}>
                          Close semester
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
                name="semesterNumber"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Semester</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      items={[
                        { value: "1", label: "Semester 1" },
                        { value: "2", label: "Semester 2" },
                      ]}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select a semester" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="1">Semester 1</SelectItem>
                        <SelectItem value="2">Semester 2</SelectItem>
                      </SelectContent>
                    </Select>
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
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Open {wizardSemester?.name} — Step {step} of 3:{" "}
              {step === 1 ? "Advance" : step === 2 ? "Assign" : "Confirm"}
            </DialogTitle>
            <DialogDescription>
              {step === 1 &&
                "Pick which classes advance to the next semester number. Unchecked classes stay at their current level but are still included below."}
              {step === 2 &&
                "Assign a lecturer to each course planned for the semester level each class is resolving into."}
              {step === 3 &&
                "Review the summary, then confirm to create assignments and auto-enroll students."}
            </DialogDescription>
          </DialogHeader>

          {otherActiveSemesters.length > 0 && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              Opening this semester will deactivate:{" "}
              {otherActiveSemesters.map((s) => s.name).join(", ")}.
            </div>
          )}

          {step === 1 && (
            <div className="flex max-h-96 flex-col gap-2 overflow-y-auto">
              {classesWithPlans.map((cls) => {
                const current = cls.currentSemesterNumber ?? 1;
                const atMax = current >= MAX_SEMESTER_NUMBER;
                const showWarning =
                  previousNotClosed && participatingSet.has(cls.id);
                return (
                  <div
                    key={cls.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
                  >
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id={`advance-${cls.id}`}
                        checked={advanceByClass[cls.id] ?? false}
                        disabled={atMax}
                        onCheckedChange={(checked) =>
                          setAdvanceByClass((prev) => ({
                            ...prev,
                            [cls.id]: checked === true,
                          }))
                        }
                      />
                      <Label htmlFor={`advance-${cls.id}`}>
                        <span className="font-semibold">{cls.name}</span>{" "}
                        <span className="text-muted-foreground">
                          {atMax
                            ? `— final semester (${current})`
                            : `— advance ${current} → ${current + 1}`}
                        </span>
                      </Label>
                    </div>
                    {showWarning && (
                      <span
                        title={`${previousActiveSemester?.name} hasn't been closed yet`}
                        className="flex shrink-0 items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
                      >
                        <AlertTriangle className="size-3.5" />
                        Not closed
                      </span>
                    )}
                  </div>
                );
              })}
              {classesWithPlans.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No class has a course plan and a semester number set yet —
                  set those up on the Classes and Course Plans pages first.
                </p>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="flex max-h-96 flex-col gap-4 overflow-y-auto">
              {classesWithPlans.map((cls) => {
                const target = targetSemesterNumber(cls);
                const plans = targetPlans(cls);
                return (
                  <div
                    key={cls.id}
                    className="rounded-lg border border-border p-3"
                  >
                    <p className="font-semibold">
                      {cls.name}{" "}
                      <span className="font-normal text-muted-foreground">
                        (semester {target})
                      </span>
                    </p>
                    <div className="mt-3 flex flex-col gap-2 pl-2">
                      {plans.map((plan) => (
                        <div
                          key={plan.id}
                          className="flex items-center justify-between gap-3"
                        >
                          <span className="text-sm">{plan.course.name}</span>
                          <div className="w-56">
                            <SearchableSelect
                              value={
                                lecturerByCourse[
                                  courseKey(cls.id, plan.courseId)
                                ] ?? ""
                              }
                              onValueChange={(value) =>
                                setLecturerByCourse((prev) => ({
                                  ...prev,
                                  [courseKey(cls.id, plan.courseId)]: value,
                                }))
                              }
                              items={lecturers.map((l) => ({
                                value: l.id,
                                label: l.user.fullName,
                              }))}
                              placeholder="Select a lecturer"
                              searchPlaceholder="Search lecturers…"
                              className="w-full"
                            />
                          </div>
                        </div>
                      ))}
                      {plans.length === 0 && (
                        <p className="text-sm text-muted-foreground">
                          No courses planned for semester {target}.
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col gap-2 rounded-lg border border-border p-4 text-sm">
              <p>
                <strong>{advancingCount}</strong> class
                {advancingCount === 1 ? "" : "es"} will advance to the next
                semester number.
              </p>
              <p>
                Up to <strong>{assignmentsCount}</strong> course assignment
                {assignmentsCount === 1 ? "" : "s"} will be created (existing
                ones are skipped), auto-enrolling their students.
              </p>
            </div>
          )}

          <div className="flex justify-between">
            <Button
              variant="outline"
              onClick={() => setStep((s) => (s === 3 ? 2 : 1))}
              disabled={step === 1}
            >
              Back
            </Button>
            {step < 3 ? (
              <Button
                onClick={() => setStep((s) => (s === 1 ? 2 : 3))}
                disabled={step === 2 && !isStep2Ready()}
              >
                Next
              </Button>
            ) : (
              <Button onClick={onOpenSemester} disabled={opening}>
                {opening ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  "Confirm and open semester"
                )}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!closeTarget}
        onOpenChange={(open) => !open && setCloseTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close {closeTarget?.name}?</DialogTitle>
            <DialogDescription>
              This cannot be undone. {activeSemesterCounts.total} assessment
              {activeSemesterCounts.total === 1 ? "" : "s"} will become
              permanently immutable: no more entry, corrections, or
              publishing.
            </DialogDescription>
          </DialogHeader>
          {activeSemesterCounts.draft > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>
                {activeSemesterCounts.draft} assessment
                {activeSemesterCounts.draft === 1 ? " is" : "s are"} still
                unpublished. Closing removes the ability to ever publish
                them — those marks will never reach students.
              </p>
            </div>
          )}
          <Button variant="destructive" onClick={onConfirmClose} disabled={closing}>
            {closing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Yes, close this semester"
            )}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
