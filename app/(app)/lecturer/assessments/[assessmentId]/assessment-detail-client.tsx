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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PageHeader } from "@/components/layout/page-header";
import { getActionErrorMessage } from "@/lib/action-error";
import { publishAssessment } from "./actions";
import { ResultGrid, type GridRow } from "./result-grid";
import { GroupsPanel } from "./groups-panel";
import type { Student, StudentGroup, GroupMember, User } from "@prisma/client";

type StudentWithUser = Student & { user: User };
type GroupWithMembers = StudentGroup & {
  members: (GroupMember & { student: StudentWithUser })[];
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

      {mode === "GROUP" ? (
        <Tabs defaultValue="results">
          <TabsList>
            <TabsTrigger value="results">Results</TabsTrigger>
            <TabsTrigger value="groups">Groups</TabsTrigger>
          </TabsList>
          <TabsContent value="results">
            <ResultGrid
              assessmentId={assessmentId}
              maximumMarks={maximumMarks}
              mode={mode}
              readOnly={readOnly}
              initialRows={gridRows}
            />
          </TabsContent>
          <TabsContent value="groups">
            <GroupsPanel
              assessmentId={assessmentId}
              assignmentId={assignmentId}
              groups={groups}
              maximumMarks={maximumMarks}
              disabled={readOnly}
            />
          </TabsContent>
        </Tabs>
      ) : (
        <ResultGrid
          assessmentId={assessmentId}
          maximumMarks={maximumMarks}
          mode={mode}
          readOnly={readOnly}
          initialRows={gridRows}
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
