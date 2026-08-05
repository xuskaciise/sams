"use client";

import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { BulkImportDialog } from "@/components/admin/bulk-import-dialog";
import { AutoTimetableGeneratorClient } from "../auto-timetable/auto-timetable-generator-client";
import type { GeneratorShiftOption } from "./generator-data";
import {
  downloadClassWorkloadTemplate,
  previewClassWorkloadImport,
  confirmClassWorkloadImport,
} from "./class-actions";
import type { ClassWorkloadImportRow } from "./class-schema";
import type { WorkloadImportConfirmResult } from "./actions";
import { ConfirmResultView } from "./workload-import-client";
import { formatClassLabel } from "@/lib/class-label";

const COLUMNS = [
  { key: "course_code", label: "Course code" },
  { key: "course_name", label: "Course name" },
  { key: "lecturer", label: "Lecturer" },
  { key: "credit_hours", label: "Credit hours" },
];

export interface WorkloadImportClassOption {
  id: string;
  name: string;
  currentSemesterNumber: number | null;
  plannedCourseCount: number;
}

interface Props {
  classes: WorkloadImportClassOption[];
  canGenerate: boolean;
  shifts: GeneratorShiftOption[];
}

export function ClassWorkloadImportClient({ classes, canGenerate, shifts }: Props) {
  const [selectedClassId, setSelectedClassId] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [createdAssignments, setCreatedAssignments] = useState<
    WorkloadImportConfirmResult["createdAssignments"]
  >([]);
  // Same "thread the original file's error count through a ref" reason as
  // the bulk flow — BulkImportDialog only forwards OK rows to onConfirm.
  const lastErrorCountRef = useRef(0);

  const selectedClass = classes.find((c) => c.id === selectedClassId) ?? null;

  if (generating) {
    return (
      <div className="flex flex-col gap-4">
        <AutoTimetableGeneratorClient
          createdAssignments={createdAssignments}
          shifts={shifts}
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
        <p className="mb-1 text-sm font-semibold">Import workload for a class</p>
        <p className="mb-4 text-sm text-muted-foreground">
          Pick a class first — the template is pre-filled with only that
          class&apos;s planned courses, so you only ever need to fill in the
          lecturer and credit hours.
        </p>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="w-full max-w-sm">
            <SearchableSelect
              value={selectedClassId}
              onValueChange={setSelectedClassId}
              items={classes.map((c) => ({
                value: c.id,
                label: formatClassLabel(c),
              }))}
              placeholder="Select a class"
              searchPlaceholder="Search classes…"
              className="w-full"
            />
          </div>
          <Button
            onClick={() => setDialogOpen(true)}
            disabled={!selectedClassId}
          >
            <Upload className="size-4" />
            Import workload for this class
          </Button>
        </div>

        {selectedClass && (
          <p className="mt-3 text-xs text-muted-foreground">
            {selectedClass.plannedCourseCount} course
            {selectedClass.plannedCourseCount === 1 ? "" : "s"} planned for
            semester level {selectedClass.currentSemesterNumber}.
          </p>
        )}

        {classes.length === 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            No class has a course plan for its current semester level yet —
            set one up on the Classes and Course Plans pages first.
          </p>
        )}
      </div>

      {selectedClassId && (
        <BulkImportDialog<ClassWorkloadImportRow>
          key={selectedClassId}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          title={`Import workload — ${selectedClass ? formatClassLabel(selectedClass) : ""}`}
          description="Download this class's template, fill in lecturer and credit hours for the courses you're assigning, then upload it back."
          columns={COLUMNS}
          onDownloadTemplate={() => downloadClassWorkloadTemplate(selectedClassId)}
          onPreview={async (formData) => {
            const result = await previewClassWorkloadImport(selectedClassId, formData);
            lastErrorCountRef.current = result.counts.error;
            return result;
          }}
          onConfirm={(rows, fileName) =>
            confirmClassWorkloadImport(selectedClassId, rows, fileName, lastErrorCountRef.current)
          }
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
      )}
    </div>
  );
}
