"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type {
  Class,
  Course,
  Lecturer,
  LecturerCourseAssignment,
  Semester,
  AcademicYear,
  User,
} from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { getActionErrorMessage } from "@/lib/action-error";
import { transferOwnership } from "./actions";

type LecturerWithUser = Lecturer & { user: User };
type AssignmentRow = LecturerCourseAssignment & {
  lecturer: LecturerWithUser;
  course: Course;
  class: Class;
  semester: Semester & { academicYear: AcademicYear };
};

export function TransfersClient({
  assignments,
  lecturers,
}: {
  assignments: AssignmentRow[];
  lecturers: LecturerWithUser[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [transferring, setTransferring] = useState<AssignmentRow | null>(null);
  const [newLecturerId, setNewLecturerId] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function openTransfer(assignment: AssignmentRow) {
    setTransferring(assignment);
    setNewLecturerId("");
    setReason("");
  }

  async function onConfirm() {
    if (!transferring) return;
    if (!newLecturerId) {
      toast.error("Pick a new lecturer.");
      return;
    }
    if (!reason.trim()) {
      toast.error("A reason is required.");
      return;
    }
    setSubmitting(true);
    try {
      await transferOwnership(transferring.id, {
        newLecturerId,
        reason: reason.trim(),
      });
      toast.success("Ownership transferred.");
      setTransferring(null);
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    } finally {
      setSubmitting(false);
    }
  }

  const otherLecturers = lecturers.filter((l) => l.id !== transferring?.lecturerId);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Transfers the assignment&apos;s lecturer AND effective ownership of
        every assessment already created under it — the new lecturer can
        immediately continue editing drafts, publishing, and correcting.
        The original creator is kept as permanent history.
      </p>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Lecturer</TableHead>
              <TableHead>Course</TableHead>
              <TableHead>Class</TableHead>
              <TableHead>Semester</TableHead>
              <TableHead className="w-32" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {assignments.map((a, i) => (
              <TableRow key={a.id} className={i % 2 === 1 ? "bg-muted/30" : undefined}>
                <TableCell className="font-medium">{a.lecturer.user.fullName}</TableCell>
                <TableCell>{a.course.name}</TableCell>
                <TableCell>{a.class.name}</TableCell>
                <TableCell>
                  {a.semester.name} ({a.semester.academicYear.name})
                </TableCell>
                <TableCell>
                  <Button variant="outline" size="sm" onClick={() => openTransfer(a)}>
                    Transfer
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {assignments.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  No assignments in an open semester.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog
        open={!!transferring}
        onOpenChange={(open) => !open && setTransferring(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transfer ownership</DialogTitle>
            <DialogDescription>
              {transferring && (
                <>
                  {transferring.course.name} · {transferring.class.name} ·{" "}
                  {transferring.semester.name} — currently{" "}
                  {transferring.lecturer.user.fullName}.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>New lecturer</Label>
              <SearchableSelect
                value={newLecturerId}
                onValueChange={setNewLecturerId}
                items={otherLecturers.map((l) => ({
                  value: l.id,
                  label: l.user.fullName,
                }))}
                placeholder="Select a lecturer"
                searchPlaceholder="Search lecturers…"
                className="w-full"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="transfer-reason">Reason (required)</Label>
              <Textarea
                id="transfer-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this assignment being reassigned?"
              />
            </div>
            <Button onClick={onConfirm} disabled={submitting}>
              {submitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                "Confirm transfer"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
