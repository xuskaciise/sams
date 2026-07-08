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
import { transferStudents } from "./actions";

type ClassWithProgram = Class & { program: Program };

export function TransferStudentsClient({
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

  function onSourceChange(classId: string) {
    if (!classId) return;
    router.push(
      `/admin/students?tab=transfer-students&sourceClassId=${classId}`
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Transfer Students"
        description="Move an individual student to a different class — e.g. a repeater or a section change. Normal semester progression happens automatically via the Open Semester wizard."
      />

      <div className="w-64">
        <SearchableSelect
          value={selectedClassId}
          onValueChange={onSourceChange}
          items={classes.map((cls) => ({
            value: cls.id,
            label: `${cls.name} (${cls.program.name})`,
          }))}
          placeholder="Select a source class"
          searchPlaceholder="Search classes…"
          className="w-full"
        />
      </div>

      {sourceClass && (
        <TransferForm
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

function TransferForm({
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
  const [transferring, setTransferring] = useState(false);

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

  async function onConfirmTransfer() {
    const studentIds = Object.entries(checked)
      .filter(([, isChecked]) => isChecked)
      .map(([id]) => id);

    setTransferring(true);
    try {
      const result = await transferStudents({
        sourceClassId: sourceClass.id,
        target:
          targetMode === "existing"
            ? { mode: "existing", classId: targetClassId }
            : { mode: "new", name: newClassName.trim() },
        studentIds,
      });
      toast.success(
        `Moved ${result.transferredCount} student${result.transferredCount === 1 ? "" : "s"} to ${targetName}.`
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
      setTransferring(false);
    }
  }

  return (
    <>
      {semesterOpenWarning && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          <p>
            The current semester ({semesterOpenWarning.name}) hasn&apos;t
            been closed yet. Transferring students now may be premature.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Checkbox
              id="ack-open-semester"
              checked={acknowledged}
              onCheckedChange={(value) => setAcknowledged(value === true)}
            />
            <Label htmlFor="ack-open-semester">
              I understand and want to transfer anyway.
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
            <SearchableSelect
              value={targetClassId}
              onValueChange={setTargetClassId}
              items={targetClasses.map((cls) => ({
                value: cls.id,
                label: cls.name,
              }))}
              placeholder="Select a target class"
              searchPlaceholder="Search classes…"
              className="w-full"
            />
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
              placeholder={`e.g. a new section for ${sourceClass.name}`}
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
          Transfer {selectedCount} student{selectedCount === 1 ? "" : "s"}
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm transfer</DialogTitle>
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
                  {sourceClass.name}.
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
          <Button onClick={onConfirmTransfer} disabled={transferring}>
            {transferring ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Confirm transfer"
            )}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
