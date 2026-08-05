"use client";

import { useMemo, useState } from "react";
import { CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AutoTimetableGeneratorClient } from "../auto-timetable/auto-timetable-generator-client";
import type { GeneratorShiftOption } from "./generator-data";
import type { CreatedAssignmentSummary } from "./actions";

interface Props {
  pendingAssignments: CreatedAssignmentSummary[];
  shifts: GeneratorShiftOption[];
}

// The success dialog's "Continue to auto-generate timetable" button only
// ever appears immediately after a fresh Excel confirm and doesn't persist
// across a reload — this card is the permanent re-entry point for
// assignments created earlier (any workload-import flow, any past
// session) that still have no TimetableSlot. Reuses the exact same
// AutoTimetableGeneratorClient the success dialog opens, so the sequential
// per-semester-level flow itself is byte-for-byte identical either way.
export function PendingAutoGenerateCard({ pendingAssignments, shifts }: Props) {
  const [generating, setGenerating] = useState(false);

  const levels = useMemo(() => {
    const set = new Set(
      pendingAssignments
        .map((a) => a.classCurrentSemesterNumber)
        .filter((n): n is number => n !== null)
    );
    return [...set].sort((a, b) => a - b);
  }, [pendingAssignments]);

  if (generating) {
    return (
      <div className="flex flex-col gap-4">
        <AutoTimetableGeneratorClient
          createdAssignments={pendingAssignments}
          shifts={shifts}
          onClose={() => setGenerating(false)}
        />
      </div>
    );
  }

  if (pendingAssignments.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4">
      <div className="flex items-start gap-3">
        <CalendarClock className="mt-0.5 size-5 text-primary" />
        <div className="text-sm">
          <p className="font-semibold">
            {pendingAssignments.length} assignment{pendingAssignments.length === 1 ? "" : "s"} not yet
            scheduled
          </p>
          <p className="text-muted-foreground">
            {levels.length > 0
              ? `From past workload imports, across semester level${levels.length === 1 ? "" : "s"} ${levels.join(", ")}.`
              : "From past workload imports."}{" "}
            No need to re-import — generate a timetable for them directly.
          </p>
        </div>
      </div>
      <Button onClick={() => setGenerating(true)}>Generate timetable</Button>
    </div>
  );
}
