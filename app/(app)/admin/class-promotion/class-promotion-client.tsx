"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowUpRight, Loader2 } from "lucide-react";
import type { Class, Program, Semester, Student } from "@prisma/client";
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
import { promoteClass } from "./actions";

type ClassWithProgram = Class & { program: Program };

export function ClassPromotionClient({
  classes,
  selectedClassId,
  sourceClass,
  students,
  targetClasses,
  activeSemester,
}: {
  classes: ClassWithProgram[];
  selectedClassId: string;
  sourceClass: ClassWithProgram | null;
  students: Student[];
  targetClasses: ClassWithProgram[];
  activeSemester: Semester | null;
}) {
  const router = useRouter();

  function onSourceChange(classId: string | null) {
    if (!classId) return;
    router.push(`/admin/students?tab=class-promotion&sourceClassId=${classId}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Class Promotion"
        description="Move students from one class to the next (e.g. CMS 1 FT -> CMS 2 FT) at semester end."
      />

      <div className="w-64">
        <Select
          value={selectedClassId}
          onValueChange={onSourceChange}
          items={classes.map((cls) => ({
            value: cls.id,
            label: `${cls.name} (${cls.program.name})`,
          }))}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select a source class" />
          </SelectTrigger>
          <SelectContent>
            {classes.map((cls) => (
              <SelectItem key={cls.id} value={cls.id}>
                {cls.name} ({cls.program.name})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {sourceClass && (
        <PromotionForm
          key={sourceClass.id}
          sourceClass={sourceClass}
          students={students}
          targetClasses={targetClasses}
          activeSemester={activeSemester}
        />
      )}
    </div>
  );
}

function PromotionForm({
  sourceClass,
  students,
  targetClasses,
  activeSemester,
}: {
  sourceClass: ClassWithProgram;
  students: Student[];
  targetClasses: ClassWithProgram[];
  activeSemester: Semester | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [targetMode, setTargetMode] = useState<"existing" | "new">("existing");
  const [targetClassId, setTargetClassId] = useState("");
  const [newClassName, setNewClassName] = useState("");
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(students.map((s) => [s.id, true]))
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [promoting, setPromoting] = useState(false);

  const semesterOpenWarning =
    !!activeSemester && !activeSemester.isClosed ? activeSemester : null;

  const selectedCount = Object.values(checked).filter(Boolean).length;
  const remainingCount = students.length - selectedCount;

  const targetName =
    targetMode === "existing"
      ? targetClasses.find((c) => c.id === targetClassId)?.name ?? ""
      : newClassName.trim();

  const canOpenConfirm =
    selectedCount > 0 &&
    !!targetName &&
    (!semesterOpenWarning || acknowledged);

  async function onConfirmPromotion() {
    const studentIds = Object.entries(checked)
      .filter(([, isChecked]) => isChecked)
      .map(([id]) => id);

    setPromoting(true);
    try {
      const result = await promoteClass({
        sourceClassId: sourceClass.id,
        target:
          targetMode === "existing"
            ? { mode: "existing", classId: targetClassId }
            : { mode: "new", name: newClassName.trim() },
        studentIds,
      });
      toast.success(
        `Promoted ${result.promotedCount} student${result.promotedCount === 1 ? "" : "s"} to ${targetName}.`
      );
      setConfirmOpen(false);
      startTransition(() => router.refresh());
    } catch (error) {
      if (error instanceof Error && error.message === "DUPLICATE_CLASS_NAME") {
        toast.error("A class with that name already exists in this program.");
      } else {
        toast.error(
          getActionErrorMessage(error, "Something went wrong. Please try again.")
        );
      }
    } finally {
      setPromoting(false);
    }
  }

  return (
    <>
      {semesterOpenWarning && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          <p>
            The current semester ({semesterOpenWarning.name}) hasn&apos;t
            been closed yet. Promoting students now may be premature.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Checkbox
              id="ack-open-semester"
              checked={acknowledged}
              onCheckedChange={(value) => setAcknowledged(value === true)}
            />
            <Label htmlFor="ack-open-semester">
              I understand and want to promote anyway.
            </Label>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <Label>Target class (same program)</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant={targetMode === "existing" ? "default" : "outline"}
            size="sm"
            onClick={() => setTargetMode("existing")}
          >
            Existing class
          </Button>
          <Button
            type="button"
            variant={targetMode === "new" ? "default" : "outline"}
            size="sm"
            onClick={() => setTargetMode("new")}
          >
            Create new class
          </Button>
        </div>

        {targetMode === "existing" ? (
          <div className="w-64">
            <Select
              value={targetClassId}
              onValueChange={(value) => setTargetClassId(value ?? "")}
              items={targetClasses.map((cls) => ({
                value: cls.id,
                label: cls.name,
              }))}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a target class" />
              </SelectTrigger>
              <SelectContent>
                {targetClasses.map((cls) => (
                  <SelectItem key={cls.id} value={cls.id}>
                    {cls.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {targetClasses.length === 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                No other classes in {sourceClass.program.name} yet — create a
                new one instead.
              </p>
            )}
          </div>
        ) : (
          <div className="w-64">
            <Input
              placeholder={`e.g. next level of ${sourceClass.name}`}
              value={newClassName}
              onChange={(e) => setNewClassName(e.target.value)}
            />
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={
                    students.length > 0 && selectedCount === students.length
                  }
                  onCheckedChange={(value) =>
                    setChecked(
                      Object.fromEntries(
                        students.map((s) => [s.id, value === true])
                      )
                    )
                  }
                />
              </TableHead>
              <TableHead>Student ID</TableHead>
              <TableHead>Full name</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {students.map((student, i) => (
              <TableRow
                key={student.id}
                className={i % 2 === 1 ? "bg-muted/30" : undefined}
              >
                <TableCell>
                  <Checkbox
                    checked={checked[student.id] ?? false}
                    onCheckedChange={(value) =>
                      setChecked((prev) => ({
                        ...prev,
                        [student.id]: value === true,
                      }))
                    }
                  />
                </TableCell>
                <TableCell className="font-medium">
                  {student.studentNo}
                </TableCell>
                <TableCell>{student.fullName}</TableCell>
              </TableRow>
            ))}
            {students.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={3}
                  className="text-center text-muted-foreground"
                >
                  No students in this class.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex justify-end">
        <Button onClick={() => setConfirmOpen(true)} disabled={!canOpenConfirm}>
          <ArrowUpRight className="size-4" />
          Promote {selectedCount} student{selectedCount === 1 ? "" : "s"}
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm promotion</DialogTitle>
            <DialogDescription>
              <span className="block">
                <strong>{selectedCount}</strong> student
                {selectedCount === 1 ? "" : "s"} will move from{" "}
                <strong>{sourceClass.name}</strong> to{" "}
                <strong>{targetName}</strong>.
              </span>
              {remainingCount > 0 && (
                <span className="mt-1 block">
                  <strong>{remainingCount}</strong> student
                  {remainingCount === 1 ? "" : "s"} will remain in{" "}
                  {sourceClass.name} (repeaters).
                </span>
              )}
              <span className="mt-2 block">
                Existing enrollments and marks are not touched — they stay
                on record against {sourceClass.name}. This does not create
                any enrollments for the target class; those come from
                &quot;Open semester&quot;.
              </span>
            </DialogDescription>
          </DialogHeader>
          <Button onClick={onConfirmPromotion} disabled={promoting}>
            {promoting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Confirm promotion"
            )}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
