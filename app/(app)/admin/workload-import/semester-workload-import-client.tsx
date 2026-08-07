"use client";

import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { BulkImportDialog } from "@/components/admin/bulk-import-dialog";
import { AutoTimetableGeneratorClient } from "../auto-timetable/auto-timetable-generator-client";
import type { GeneratorShiftOption, GeneratorRoomOption } from "./generator-data";
import {
  downloadSemesterWorkloadTemplate,
  previewSemesterWorkloadImport,
  confirmSemesterWorkloadImport,
} from "./semester-actions";
import type { SemesterWorkloadImportRow } from "./semester-schema";
import type { WorkloadImportConfirmResult } from "./actions";
import { ConfirmResultView } from "./workload-import-client";

const COLUMNS = [
  { key: "semester_level", label: "Semester level" },
  { key: "class", label: "Class" },
  { key: "course_code", label: "Course code" },
  { key: "course_name", label: "Course name" },
  { key: "lecturer", label: "Lecturer" },
  { key: "credit_hours", label: "Credit hours" },
];

export interface WorkloadImportSemesterOption {
  semesterNumber: number;
  classCount: number;
}

interface Props {
  semesterNumberOptions: WorkloadImportSemesterOption[];
  canGenerate: boolean;
  shifts: GeneratorShiftOption[];
  rooms: GeneratorRoomOption[];
  activeAcademicSemesterNumber: number | null;
}

export function SemesterWorkloadImportClient({
  semesterNumberOptions,
  canGenerate,
  shifts,
  rooms,
  activeAcademicSemesterNumber,
}: Props) {
  const [selected, setSelected] = useState<number[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [createdAssignments, setCreatedAssignments] = useState<
    WorkloadImportConfirmResult["createdAssignments"]
  >([]);
  // Same "thread the original file's error count through a ref" reason as
  // every other workload-import variant — BulkImportDialog only forwards
  // OK rows to onConfirm.
  const lastErrorCountRef = useRef(0);

  function toggle(semesterNumber: number, checked: boolean) {
    setSelected((prev) =>
      checked ? [...prev, semesterNumber].sort((a, b) => a - b) : prev.filter((n) => n !== semesterNumber)
    );
  }

  if (generating) {
    return (
      <div className="flex flex-col gap-4">
        <AutoTimetableGeneratorClient
          createdAssignments={createdAssignments}
          shifts={shifts}
          rooms={rooms}
          activeAcademicSemesterNumber={activeAcademicSemesterNumber}
          onClose={() => {
            setGenerating(false);
            setCreatedAssignments([]);
          }}
        />
      </div>
    );
  }

  const selectionKey = selected.join(",");

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-card p-6">
        <p className="mb-1 text-sm font-semibold">
          Import workload for semester level(s)
        </p>
        <p className="mb-4 text-sm text-muted-foreground">
          Pick one or more semester levels — the template lists every class
          currently at those levels together with its planned courses, so
          you only ever need to fill in the lecturer and credit hours.
        </p>

        {semesterNumberOptions.length > 0 ? (
          <div className="flex flex-wrap gap-4">
            {semesterNumberOptions.map((opt) => (
              <div key={opt.semesterNumber} className="flex items-center gap-2">
                <Checkbox
                  id={`sem-level-${opt.semesterNumber}`}
                  checked={selected.includes(opt.semesterNumber)}
                  onCheckedChange={(checked) =>
                    toggle(opt.semesterNumber, checked === true)
                  }
                />
                <Label htmlFor={`sem-level-${opt.semesterNumber}`} className="font-normal">
                  Semester {opt.semesterNumber}{" "}
                  <span className="text-muted-foreground">
                    ({opt.classCount} class{opt.classCount === 1 ? "" : "es"})
                  </span>
                </Label>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No class has a course plan for its current semester level yet —
            set one up on the Classes and Course Plans pages first.
          </p>
        )}

        <Button
          className="mt-4"
          onClick={() => setDialogOpen(true)}
          disabled={selected.length === 0}
        >
          <Upload className="size-4" />
          Import workload for {selected.length || ""} semester level
          {selected.length === 1 ? "" : "s"}
        </Button>
      </div>

      {selected.length > 0 && (
        <BulkImportDialog<SemesterWorkloadImportRow>
          key={selectionKey}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          title={`Import workload — Semester${selected.length === 1 ? "" : "s"} ${selected.join(", ")}`}
          description="Download the template covering every class at these semester levels, fill in lecturer and credit hours, then upload it back."
          columns={COLUMNS}
          onDownloadTemplate={() => downloadSemesterWorkloadTemplate(selected)}
          onPreview={async (formData) => {
            const result = await previewSemesterWorkloadImport(selected, formData);
            lastErrorCountRef.current = result.counts.error;
            return result;
          }}
          onConfirm={(rows, fileName) =>
            confirmSemesterWorkloadImport(selected, rows, fileName, lastErrorCountRef.current)
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
