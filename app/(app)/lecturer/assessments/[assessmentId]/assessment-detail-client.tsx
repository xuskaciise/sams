"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/layout/page-header";
import { getActionErrorMessage } from "@/lib/action-error";
import { publishAssessment } from "./actions";
import { ResultGrid, type GridRow } from "./result-grid";
import { GroupResultGrid } from "./group-result-grid";
import type { Student, StudentGroup, GroupMember } from "@prisma/client";

type GroupWithMembers = StudentGroup & {
  members: (GroupMember & { student: Student })[];
};

export function AssessmentDetailClient({
  assessmentId,
  title,
  status,
  mode,
  maximumMarks,
  typeName,
  courseName,
  className,
  semesterName,
  gridRows,
  groups,
  assignmentId,
}: {
  assessmentId: string;
  title: string;
  status: "DRAFT" | "PUBLISHED" | "CLOSED";
  mode: "INDIVIDUAL" | "GROUP";
  maximumMarks: number;
  typeName: string;
  courseName: string;
  className: string;
  semesterName: string;
  gridRows: GridRow[];
  groups: GroupWithMembers[];
  assignmentId: string;
}) {
  const router = useRouter();
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const enteredCount = gridRows.filter(
    (r) => r.mark !== null || r.attendanceStatus !== "PRESENT"
  ).length;

  // Live "X of Y students have a result" coverage summary — draft or
  // published both count, since the question is "does a result row exist
  // at all", not "is it visible to the student". Seeded once from the
  // server-fetched gridRows, then kept live entirely through direct
  // callbacks from the grid(s) below at the exact moment a result is
  // created (saveResult's first save for a student, a group's "same mark"
  // save, or a late-add) — never by waiting on a page reload, and never by
  // re-deriving from props, since a client component's own useState won't
  // pick up a later prop change on its own.
  const [hasResultByEnrollment, setHasResultByEnrollment] = useState<
    Record<string, boolean>
  >(() =>
    Object.fromEntries(gridRows.map((r) => [r.enrollmentId, r.resultId !== null]))
  );
  const resultCount = Object.values(hasResultByEnrollment).filter(Boolean).length;
  const totalStudents = gridRows.length;
  const missingCount = totalStudents - resultCount;

  function markResultRecorded(enrollmentId: string) {
    setHasResultByEnrollment((prev) =>
      prev[enrollmentId] ? prev : { ...prev, [enrollmentId]: true }
    );
  }

  async function onPublish() {
    setPublishing(true);
    try {
      await publishAssessment(assessmentId);
      toast.success("Results published.");
      setPublishOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(
        getActionErrorMessage(error, "Something went wrong. Please try again.")
      );
    } finally {
      setPublishing(false);
    }
  }

  const readOnly = status !== "DRAFT";
  // Late-add (a new result for a student with none yet) only makes sense
  // once the assessment is PUBLISHED — a DRAFT assessment already lets
  // every enrolled student be entered normally, and a CLOSED one is fully
  // immutable (same "closing is one-way" rule as everywhere else).
  const canLateAdd = status === "PUBLISHED";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={title}
        description={`${typeName} · ${courseName} · ${className} · ${semesterName} · Max ${maximumMarks}`}
        action={
          <div className="flex items-center gap-2">
            <Badge variant={status === "PUBLISHED" ? "published" : "draft"}>
              {status}
            </Badge>
            {status === "DRAFT" && (
              <Button onClick={() => setPublishOpen(true)}>Publish</Button>
            )}
          </div>
        }
      />

      {totalStudents > 0 && (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            {resultCount} of {totalStudents}
          </span>{" "}
          students have a result
          {missingCount > 0 && ` — ${missingCount} missing`}
        </p>
      )}

      {mode === "GROUP" ? (
        <GroupResultGrid
          assessmentId={assessmentId}
          assignmentId={assignmentId}
          maximumMarks={maximumMarks}
          readOnly={readOnly}
          canLateAdd={canLateAdd}
          groups={groups}
          gridRows={gridRows}
          onResultRecorded={markResultRecorded}
        />
      ) : (
        <ResultGrid
          assessmentId={assessmentId}
          maximumMarks={maximumMarks}
          mode={mode}
          readOnly={readOnly}
          canLateAdd={canLateAdd}
          initialRows={gridRows}
          onResultRecorded={markResultRecorded}
        />
      )}

      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish results?</DialogTitle>
            <DialogDescription>
              {enteredCount} of {gridRows.length} students have a mark or
              attendance status recorded. Once published, results become
              visible to students and can only be changed through the
              correction flow.
            </DialogDescription>
          </DialogHeader>
          <Button onClick={onPublish} disabled={publishing}>
            {publishing ? "Publishing…" : "Publish results"}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
