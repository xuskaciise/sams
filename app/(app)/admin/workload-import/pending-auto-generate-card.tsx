"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AutoTimetableGeneratorClient } from "../auto-timetable/auto-timetable-generator-client";
import { classifySemesterNumbersByEligibility, describeIneligibleLevels } from "@/lib/auto-timetable";
import type { GeneratorShiftOption } from "./generator-data";
import type { CreatedAssignmentSummary } from "./actions";

interface Props {
  pendingAssignments: CreatedAssignmentSummary[];
  shifts: GeneratorShiftOption[];
  // The active academic-calendar Semester's own semesterNumber (1 or 2) —
  // see lib/auto-timetable.ts's parityForAcademicSemesterNumber. Drives
  // which pending assignments are actually eligible to generate right now
  // (Semester 1 active -> only odd Class.currentSemesterNumber levels;
  // Semester 2 -> only even ones), same rule the generator itself applies.
  activeAcademicSemesterNumber: number | null;
}

// The success dialog's "Continue to auto-generate timetable" button only
// ever appears immediately after a fresh Excel confirm and doesn't persist
// across a reload — this card is the permanent re-entry point for
// assignments created earlier (any workload-import flow, any past
// session) that still have no TimetableSlot. Reuses the exact same
// AutoTimetableGeneratorClient the success dialog opens, so the sequential
// per-semester-level flow itself is byte-for-byte identical either way.
export function PendingAutoGenerateCard({ pendingAssignments, shifts, activeAcademicSemesterNumber }: Props) {
  const [generating, setGenerating] = useState(false);

  // Only assignments matching the active academic semester's parity are
  // actually generatable THIS cycle — the rest aren't silently dropped
  // from the count, they're surfaced separately with an explanation (see
  // ineligibleMessage below), same as the generator's own banner.
  const { eligibleAssignments, eligibleLevels, ineligibleAssignments, ineligibleLevels } = useMemo(() => {
    const { eligible, ineligible } = classifySemesterNumbersByEligibility(
      pendingAssignments.map((a) => a.classCurrentSemesterNumber),
      activeAcademicSemesterNumber
    );
    const eligibleSet = new Set(eligible);
    const ineligibleSet = new Set(ineligible);
    return {
      eligibleAssignments: pendingAssignments.filter(
        (a) => a.classCurrentSemesterNumber !== null && eligibleSet.has(a.classCurrentSemesterNumber)
      ),
      eligibleLevels: eligible,
      ineligibleAssignments: pendingAssignments.filter(
        (a) => a.classCurrentSemesterNumber !== null && ineligibleSet.has(a.classCurrentSemesterNumber)
      ),
      ineligibleLevels: ineligible,
    };
  }, [pendingAssignments, activeAcademicSemesterNumber]);

  if (generating) {
    return (
      <div className="flex flex-col gap-4">
        <AutoTimetableGeneratorClient
          createdAssignments={pendingAssignments}
          shifts={shifts}
          activeAcademicSemesterNumber={activeAcademicSemesterNumber}
          onClose={() => setGenerating(false)}
        />
      </div>
    );
  }

  if (eligibleAssignments.length === 0 && ineligibleAssignments.length === 0) return null;

  const ineligibleMessage = describeIneligibleLevels(ineligibleLevels, activeAcademicSemesterNumber);

  return (
    <div className="flex flex-col gap-2">
      {eligibleAssignments.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4">
          <div className="flex items-start gap-3">
            <CalendarClock className="mt-0.5 size-5 text-primary" />
            <div className="text-sm">
              <p className="font-semibold">
                {eligibleAssignments.length} assignment{eligibleAssignments.length === 1 ? "" : "s"} not
                yet scheduled
              </p>
              <p className="text-muted-foreground">
                From past workload imports, across semester level
                {eligibleLevels.length === 1 ? "" : "s"} {eligibleLevels.join(", ")}. No need to
                re-import — generate a timetable for them directly.
              </p>
            </div>
          </div>
          <Button onClick={() => setGenerating(true)}>Generate timetable</Button>
        </div>
      )}

      {ineligibleMessage && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <p>
            {ineligibleAssignments.length} assignment{ineligibleAssignments.length === 1 ? "" : "s"} not
            yet scheduled {ineligibleAssignments.length === 1 ? "isn't" : "aren't"} eligible this cycle.{" "}
            {ineligibleMessage}
          </p>
        </div>
      )}
    </div>
  );
}
