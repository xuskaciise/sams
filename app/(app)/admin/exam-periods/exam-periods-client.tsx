"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, MoreHorizontal, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { createSpecialExamPeriod, setSpecialExamPeriodStatus } from "./actions";
import type { ExamPeriodsPanelData } from "./queries";

export function ExamPeriodsClient({ periods, academicYears }: ExamPeriodsPanelData) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [academicYearId, setAcademicYearId] = useState("");
  const [semesterId, setSemesterId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const usedCombos = useMemo(
    () => new Set(periods.map((p) => `${p.academicYearId}:${p.semesterId}`)),
    [periods]
  );

  const selectedYear = academicYears.find((y) => y.id === academicYearId);
  const availableSemesters = (selectedYear?.semesters ?? []).filter(
    (s) => !usedCombos.has(`${academicYearId}:${s.id}`)
  );

  function openCreate() {
    setAcademicYearId("");
    setSemesterId("");
    setDialogOpen(true);
  }

  function selectYear(id: string) {
    setAcademicYearId(id);
    setSemesterId(""); // the previous semester pick no longer applies to a different year
  }

  async function handleCreate() {
    setSubmitting(true);
    try {
      await createSpecialExamPeriod({ academicYearId, semesterId });
      toast.success("Special Exam Period created.");
      setDialogOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Could not create the period. Please try again.")
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleClose(period: ExamPeriodsPanelData["periods"][number]) {
    if (
      !window.confirm(
        `Close "${period.name}"? This will prevent any further missed-exam registrations for this period. This can be reopened later if needed.`
      )
    ) {
      return;
    }
    try {
      await setSpecialExamPeriodStatus(period.id, "CLOSED");
      toast.success("Period closed.");
      router.refresh();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not close the period."));
    }
  }

  async function handleReopen(id: string) {
    try {
      await setSpecialExamPeriodStatus(id, "OPEN");
      toast.success("Period reopened.");
      router.refresh();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not reopen the period."));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Special Exam Periods"
        description="Define which academic year + semester a special/missed exam sitting covers, before registering students against it."
        action={
          <Button onClick={openCreate}>
            <Plus className="size-4" />
            Create period
          </Button>
        }
      />

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Period</TableHead>
              <TableHead>Academic Year</TableHead>
              <TableHead>Semester</TableHead>
              <TableHead className="text-right">Records</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created by</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {periods.map((p, i) => (
              <TableRow key={p.id} className={i % 2 === 1 ? "bg-muted/30" : undefined}>
                <TableCell className="font-medium">{p.name}</TableCell>
                <TableCell className="text-muted-foreground">{p.academicYear.name}</TableCell>
                <TableCell className="text-muted-foreground">{p.semester.name}</TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {p._count.records}
                </TableCell>
                <TableCell>
                  <Badge variant={p.status === "OPEN" ? "published" : "secondary"}>
                    {p.status === "OPEN" ? "Open" : "Closed"}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{p.createdBy.fullName}</TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<Button variant="ghost" size="icon-sm" />}
                    >
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {p.status === "OPEN" ? (
                        <DropdownMenuItem onClick={() => handleClose(p)}>Close</DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onClick={() => handleReopen(p.id)}>
                          Reopen
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
            {periods.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  No Special Exam Periods yet — create one to start registering missed exams.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Special Exam Period</DialogTitle>
            <DialogDescription>
              Pick the academic year and semester this special exam sitting
              covers. The name is generated automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">Academic Year</label>
              <Select value={academicYearId} onValueChange={(value) => selectYear(value ?? "")}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select an academic year" />
                </SelectTrigger>
                <SelectContent>
                  {academicYears.map((y) => (
                    <SelectItem key={y.id} value={y.id}>
                      {y.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">Semester</label>
              <Select
                value={semesterId}
                onValueChange={(value) => setSemesterId(value ?? "")}
                disabled={!academicYearId}
              >
                <SelectTrigger className="w-full">
                  <SelectValue
                    placeholder={
                      !academicYearId ? "Select an academic year first" : "Select a semester"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {availableSemesters.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {academicYearId && availableSemesters.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Every semester in this academic year already has a Special
                  Exam Period.
                </p>
              )}
            </div>
            {academicYearId && semesterId && (
              <p className="text-sm text-muted-foreground">
                This will create:{" "}
                <span className="font-medium text-foreground">
                  {selectedYear?.name} —{" "}
                  {selectedYear?.semesters.find((s) => s.id === semesterId)?.name}
                </span>
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              onClick={handleCreate}
              disabled={!academicYearId || !semesterId || submitting}
            >
              {submitting && <Loader2 className="size-4 animate-spin" />}
              Create period
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
