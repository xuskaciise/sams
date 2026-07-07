"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, Plus, Trash2 } from "lucide-react";
import type { Class, ClassCoursePlan, Course } from "@prisma/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
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
import { PageHeader } from "@/components/layout/page-header";
import { getActionErrorMessage } from "@/lib/action-error";
import { addCourseToPlan, removeCourseFromPlan, copyPlanFromClass } from "./actions";

type PlanRow = ClassCoursePlan & { course: Course };

export function CoursePlansClient({
  classes,
  courses,
  plan,
  selectedClassId,
}: {
  classes: Class[];
  courses: Course[];
  plan: PlanRow[];
  selectedClassId: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [addCourseId, setAddCourseId] = useState("");
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copySourceId, setCopySourceId] = useState("");
  const [copying, setCopying] = useState(false);

  const plannedCourseIds = new Set(plan.map((p) => p.courseId));
  const availableCourses = courses.filter((c) => !plannedCourseIds.has(c.id));

  function onClassChange(classId: string | null) {
    if (!classId) return;
    setAddCourseId("");
    router.push(`/admin/course-plans?classId=${classId}`);
  }

  async function onAddCourse() {
    if (!addCourseId || !selectedClassId) return;
    setAdding(true);
    try {
      await addCourseToPlan(selectedClassId, addCourseId);
      toast.success("Course added to plan.");
      setAddCourseId("");
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    } finally {
      setAdding(false);
    }
  }

  async function onRemoveCourse(planId: string) {
    setRemovingId(planId);
    try {
      await removeCourseFromPlan(planId);
      toast.success("Course removed from plan.");
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    } finally {
      setRemovingId(null);
    }
  }

  async function onCopyPlan() {
    if (!copySourceId || !selectedClassId) return;
    setCopying(true);
    try {
      const { copied } = await copyPlanFromClass(selectedClassId, copySourceId);
      toast.success(
        copied === 0
          ? "Nothing new to copy — that class's plan is already included."
          : `Copied ${copied} course${copied === 1 ? "" : "s"} into this plan.`
      );
      setCopyOpen(false);
      setCopySourceId("");
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    } finally {
      setCopying(false);
    }
  }

  const selectedClass = classes.find((c) => c.id === selectedClassId);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Course Plans"
        description="The reusable, per-class curriculum template consumed when opening a semester."
      />

      <div className="w-64">
        <Select
          value={selectedClassId}
          onValueChange={onClassChange}
          items={classes.map((cls) => ({ value: cls.id, label: cls.name }))}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select a class" />
          </SelectTrigger>
          <SelectContent>
            {classes.map((cls) => (
              <SelectItem key={cls.id} value={cls.id}>
                {cls.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selectedClassId && (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-64">
              <Select
                value={addCourseId}
                onValueChange={(value) => setAddCourseId(value ?? "")}
                items={availableCourses.map((c) => ({
                  value: c.id,
                  label: c.name,
                }))}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Add a course…" />
                </SelectTrigger>
                <SelectContent>
                  {availableCourses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={onAddCourse} disabled={!addCourseId || adding}>
              <Plus className="size-4" />
              Add to plan
            </Button>
            <Button variant="outline" onClick={() => setCopyOpen(true)}>
              <Copy className="size-4" />
              Copy plan from another class
            </Button>
          </div>

          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Course</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {plan.map((p, i) => (
                  <TableRow
                    key={p.id}
                    className={i % 2 === 1 ? "bg-muted/30" : undefined}
                  >
                    <TableCell className="font-medium">
                      {p.course.name}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={removingId === p.id}
                        onClick={() => onRemoveCourse(p.id)}
                      >
                        <Trash2 className="size-4" />
                        <span className="sr-only">Remove from plan</span>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {plan.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={2}
                      className="text-center text-muted-foreground"
                    >
                      No courses planned for this class yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      <Dialog open={copyOpen} onOpenChange={setCopyOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy plan from another class</DialogTitle>
            <DialogDescription>
              Add every planned course from another class into{" "}
              {selectedClass?.name}&apos;s plan. Courses already in this plan
              are skipped.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <Select
              value={copySourceId}
              onValueChange={(value) => setCopySourceId(value ?? "")}
              items={classes
                .filter((c) => c.id !== selectedClassId)
                .map((c) => ({ value: c.id, label: c.name }))}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a source class" />
              </SelectTrigger>
              <SelectContent>
                {classes
                  .filter((c) => c.id !== selectedClassId)
                  .map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Button onClick={onCopyPlan} disabled={!copySourceId || copying}>
              Copy plan
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
