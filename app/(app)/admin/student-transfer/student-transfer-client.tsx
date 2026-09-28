"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { getSchedulingErrorMessage } from "@/lib/action-error";
import { previewStudentClassTransfer, transferStudentClass } from "./actions";
import type { StudentTransferPlan } from "./plan";

interface StudentOption {
  id: string;
  studentNo: string;
  fullName: string;
  classId: string;
  classLabel: string;
}

interface ClassOption {
  id: string;
  label: string;
}

export function StudentTransferClient({
  students,
  classes,
  activeSemesterName,
  initialStudentId,
}: {
  students: StudentOption[];
  classes: ClassOption[];
  activeSemesterName: string | null;
  initialStudentId: string;
}) {
  const router = useRouter();
  const [studentId, setStudentId] = useState(
    students.some((s) => s.id === initialStudentId) ? initialStudentId : ""
  );
  const [targetClassId, setTargetClassId] = useState("");
  const [plan, setPlan] = useState<StudentTransferPlan | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const student = students.find((s) => s.id === studentId) ?? null;

  const studentItems = useMemo(
    () =>
      students.map((s) => ({
        value: s.id,
        label: `${s.studentNo} — ${s.fullName}`,
        keywords: [s.classLabel],
      })),
    [students]
  );

  // The student's current class is never offered as a target.
  const classItems = useMemo(
    () =>
      classes
        .filter((c) => c.id !== student?.classId)
        .map((c) => ({ value: c.id, label: c.label })),
    [classes, student?.classId]
  );

  function selectStudent(id: string) {
    setStudentId(id);
    const next = students.find((s) => s.id === id);
    if (next && next.classId === targetClassId) setTargetClassId("");
  }

  async function openPreview() {
    if (!studentId || !targetClassId) return;
    setLoadingPreview(true);
    try {
      const result = await previewStudentClassTransfer({ studentId, targetClassId });
      setAcknowledged(false);
      setPlan(result);
    } catch (error) {
      toast.error(getSchedulingErrorMessage(error, "Could not prepare this transfer."));
    } finally {
      setLoadingPreview(false);
    }
  }

  async function confirm() {
    if (!plan) return;
    setSubmitting(true);
    try {
      const result = await transferStudentClass({
        studentId: plan.student.id,
        targetClassId: plan.toClass.id,
        acknowledgeNoCourses: acknowledged,
      });
      toast.success(
        `${plan.student.fullName} moved to ${plan.toClass.label} — ${result.transferredCount} enrollment(s) transferred, ${result.createdCount} created, ${result.linkedCount} carried over.`
      );
      setPlan(null);
      setStudentId("");
      setTargetClassId("");
      router.refresh();
    } catch (error) {
      toast.error(getSchedulingErrorMessage(error, "Could not transfer this student."));
    } finally {
      setSubmitting(false);
    }
  }

  const needsAck = !!plan && plan.enrollmentsAffected && plan.targetHasNoCourses;

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 sm:p-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label>Student</Label>
          <SearchableSelect
            value={studentId}
            onValueChange={selectStudent}
            items={studentItems}
            placeholder="Search by student ID or name"
            emptyMessage="No active students found."
          />
          {student && (
            <p className="text-xs text-muted-foreground">Current class: {student.classLabel}</p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Target class</Label>
          <SearchableSelect
            value={targetClassId}
            onValueChange={setTargetClassId}
            items={classItems}
            placeholder={student ? "Search classes" : "Select a student first"}
            emptyMessage="No other classes available."
            disabled={!student}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Active semester: {activeSemesterName ?? "none"} — only its enrollments are changed; closed
        semesters are never touched.
      </p>
      <div className="flex justify-end">
        <Button onClick={openPreview} disabled={!studentId || !targetClassId || loadingPreview}>
          {loadingPreview && <Loader2 className="size-4 animate-spin" />}
          Review transfer
        </Button>
      </div>

      <Dialog open={!!plan} onOpenChange={(open) => !open && !submitting && setPlan(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          {plan && (
            <>
              <DialogHeader>
                <DialogTitle>Confirm class transfer</DialogTitle>
                <DialogDescription>
                  {plan.student.studentNo} — {plan.student.fullName}
                </DialogDescription>
              </DialogHeader>

              <div className="flex flex-col gap-4 text-sm">
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3">
                  <span className="font-medium">{plan.fromClass.label}</span>
                  <ArrowRight className="size-4 text-muted-foreground" />
                  <span className="font-medium">{plan.toClass.label}</span>
                </div>

                {!plan.enrollmentsAffected ? (
                  <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <p>
                      {plan.activeSemester
                        ? `${plan.activeSemester.name} is closed`
                        : "There is no active semester"}{" "}
                      — only the student&apos;s class will change. No enrollments, marks, or groups
                      are touched; new-class enrollments will come from the next Open Semester.
                    </p>
                  </div>
                ) : (
                  <>
                    <section className="flex flex-col gap-1.5">
                      <h3 className="font-semibold">
                        Enrollments marked Transferred ({plan.toTransfer.length})
                      </h3>
                      {plan.toTransfer.length === 0 ? (
                        <p className="text-muted-foreground">
                          No active enrollments in {plan.activeSemester?.name}.
                        </p>
                      ) : (
                        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                          {plan.toTransfer.map((t) => (
                            <li key={t.enrollmentId} className="flex items-center justify-between gap-2 px-3 py-2">
                              <span>{t.courseName}</span>
                              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                                {t.publishedMarkCount} published mark(s)
                                {t.carriesOver ? (
                                  <Badge variant="published">Carries over</Badge>
                                ) : (
                                  <Badge variant="outline">Archived</Badge>
                                )}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Marks are never moved. “Carries over” = the new class also teaches this
                        course, so the new lecturer and the student see these marks read-only.
                        “Archived” = old-class-only course, kept on the transferred enrollment for
                        history and reports.
                      </p>
                    </section>

                    <section className="flex flex-col gap-1.5">
                      <h3 className="font-semibold">New enrollments ({plan.toCreate.length})</h3>
                      {plan.toCreate.length === 0 ? (
                        <p className="text-muted-foreground">None.</p>
                      ) : (
                        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                          {plan.toCreate.map((c) => (
                            <li key={c.courseId} className="flex items-center justify-between gap-2 px-3 py-2">
                              <span>{c.courseName}</span>
                              <span className="text-xs text-muted-foreground">{c.lecturerName}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>

                    {plan.groupsToLeave.length > 0 && (
                      <section className="flex flex-col gap-1.5">
                        <h3 className="font-semibold">Groups left ({plan.groupsToLeave.length})</h3>
                        <ul className="list-disc pl-5 text-muted-foreground">
                          {plan.groupsToLeave.map((g) => (
                            <li key={g.groupId}>
                              {g.groupName} — {g.courseName}
                            </li>
                          ))}
                        </ul>
                        <p className="text-xs text-muted-foreground">
                          Already-saved results keep their group reference.
                        </p>
                      </section>
                    )}

                    {needsAck && (
                      <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
                        <p className="flex gap-2">
                          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                          {plan.toClass.label} has no course assignments in{" "}
                          {plan.activeSemester?.name} — no courses will be enrolled.
                        </p>
                        <label className="flex items-center gap-2">
                          <Checkbox
                            checked={acknowledged}
                            onCheckedChange={(v) => setAcknowledged(v === true)}
                          />
                          Transfer anyway
                        </label>
                      </div>
                    )}
                  </>
                )}
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setPlan(null)} disabled={submitting}>
                  Cancel
                </Button>
                <Button onClick={confirm} disabled={submitting || (needsAck && !acknowledged)}>
                  {submitting && <Loader2 className="size-4 animate-spin" />}
                  Confirm transfer
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
