"use client";

import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { BulkImportDialog } from "@/components/admin/bulk-import-dialog";
import { AutoTimetableGeneratorClient } from "../auto-timetable/auto-timetable-generator-client";
import type { GeneratorShiftOption } from "./generator-data";
import {
  downloadWorkloadImportTemplate,
  previewWorkloadImport,
  confirmWorkloadImport,
  type WorkloadImportConfirmResult,
} from "./actions";
import type { WorkloadImportRow } from "./schema";
import { formatClassLabel } from "@/lib/class-label";

const COLUMNS = [
  { key: "semester", label: "Semester" },
  { key: "program", label: "Program" },
  { key: "class", label: "Class" },
  { key: "course", label: "Course" },
  { key: "lecturer", label: "Lecturer" },
  { key: "credit_hours", label: "Credit hours" },
];

interface Props {
  canGenerate: boolean;
  shifts: GeneratorShiftOption[];
  activeAcademicSemesterNumber: number | null;
}

export function WorkloadImportClient({ canGenerate, shifts, activeAcademicSemesterNumber }: Props) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [createdAssignments, setCreatedAssignments] = useState<
    WorkloadImportConfirmResult["createdAssignments"]
  >([]);
  // Captured from the preview step so the success dialog can show the
  // original file's error count too — BulkImportDialog only forwards OK
  // rows to onConfirm, so this is threaded through a ref rather than
  // through the dialog's own props.
  const lastErrorCountRef = useRef(0);

  if (generating) {
    return (
      <div className="flex flex-col gap-4">
        <AutoTimetableGeneratorClient
          createdAssignments={createdAssignments}
          shifts={shifts}
          activeAcademicSemesterNumber={activeAcademicSemesterNumber}
          onClose={() => {
            setGenerating(false);
            setCreatedAssignments([]);
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-card p-6">
        <p className="mb-1 text-sm font-semibold">Import course workload</p>
        <p className="mb-4 text-sm text-muted-foreground">
          Upload an Excel file with columns semester, program, class, course, lecturer, and
          credit_hours to create lecturer-course assignments in bulk.
        </p>
        <Button onClick={() => setDialogOpen(true)}>
          <Upload className="size-4" />
          Import workload
        </Button>
      </div>

      <BulkImportDialog<WorkloadImportRow>
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title="Import course workload"
        description="Upload an Excel file to create lecturer-course assignments with credit hours."
        columns={COLUMNS}
        onDownloadTemplate={downloadWorkloadImportTemplate}
        onPreview={async (formData) => {
          const result = await previewWorkloadImport(formData);
          lastErrorCountRef.current = result.counts.error;
          return result;
        }}
        onConfirm={(rows, fileName) => confirmWorkloadImport(rows, fileName, lastErrorCountRef.current)}
        renderConfirmResult={(result, onDone) => {
          const r = result as WorkloadImportConfirmResult;
          return (
            <ConfirmResultView
              result={r}
              canGenerate={canGenerate}
              onDone={onDone}
              onContinue={() => {
                setCreatedAssignments(r.createdAssignments);
                setGenerating(true);
                onDone();
              }}
            />
          );
        }}
      />
    </div>
  );
}

// Exported so the per-class flow (class-workload-import-client.tsx) can
// render the exact same success dialog — WorkloadImportConfirmResult is
// identical regardless of which flow created the assignments, so there is
// nothing flow-specific to duplicate here.
export function ConfirmResultView({
  result,
  canGenerate,
  onDone,
  onContinue,
}: {
  result: WorkloadImportConfirmResult;
  canGenerate: boolean;
  onDone: () => void;
  onContinue: () => void;
}) {
  const skipped = result.skipped + result.errorsInFile;
  // Computed from the created rows themselves rather than a dedicated
  // field — any variant (per-class, per-semester-level(s), or the bulk
  // multi-class flow) that happens to span more than one class benefits
  // from this, not just the new per-semester-level flow.
  const distinctClassIds = new Set(result.createdAssignments.map((a) => a.classId));
  const distinctLevels = new Set(
    result.createdAssignments
      .map((a) => a.classCurrentSemesterNumber)
      .filter((n): n is number => n !== null)
  );
  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Workload import complete</DialogTitle>
      </DialogHeader>
      <p className="text-sm">
        Course assignments created: <strong>{result.created} new</strong>
        {distinctClassIds.size > 1 && (
          <>
            {" "}
            across <strong>{distinctClassIds.size} classes</strong>
            {distinctLevels.size > 1 && (
              <>
                {" "}
                / <strong>{distinctLevels.size} semester levels</strong>
              </>
            )}
          </>
        )}
        , <strong>{skipped} skipped</strong>, <strong>{result.errorsInFile} error</strong>
        {result.errorsInFile === 1 ? "" : "s"}.
      </p>

      {result.createdAssignments.length > 0 && (
        <div className="max-h-64 overflow-auto rounded-lg border border-border">
          <Table>
            <TableHeader className="sticky top-0 bg-card">
              <TableRow>
                <TableHead>Lecturer</TableHead>
                <TableHead>Course</TableHead>
                <TableHead>Class</TableHead>
                <TableHead>Semester</TableHead>
                <TableHead className="text-right">Credit hrs</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.createdAssignments.map((a) => (
                <TableRow key={a.assignmentId}>
                  <TableCell>{a.lecturerName}</TableCell>
                  <TableCell>{a.courseName}</TableCell>
                  <TableCell>
                    {formatClassLabel({
                      name: a.className,
                      currentSemesterNumber: a.classCurrentSemesterNumber,
                    })}
                  </TableCell>
                  <TableCell>{a.semesterLabel}</TableCell>
                  <TableCell className="text-right">{a.creditHours}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {result.createdAssignments.length === 0 && (
        <Badge variant="outline" className="w-fit">
          No new assignments were created
        </Badge>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Done
        </Button>
        {canGenerate && result.createdAssignments.length > 0 && (
          <Button type="button" onClick={onContinue}>
            Continue to auto-generate timetable
          </Button>
        )}
      </DialogFooter>
    </div>
  );
}
