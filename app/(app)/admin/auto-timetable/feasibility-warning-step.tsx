"use client";

// The "Feasibility check" wizard step — shown once per semester-level
// batch, AFTER the "Lecturer availability" step (if that one ran) but
// BEFORE the algorithm ever runs for this level, whenever at least one
// lecturer's required session time exceeds what their own availability
// could ever physically fit. Pure client-side math (checkBatchFeasibility,
// lib/auto-timetable.ts) run against data already loaded — no extra round
// trip. This is advisory, not a hard block: an admin/dean who has already
// decided to accept the overload (or knows generation will simply leave
// some of that lecturer's sessions Unscheduled, which is fine too) can
// continue anyway.

import { AlertTriangle, ArrowRight, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatFeasibilityMessage, type LecturerFeasibility } from "@/lib/auto-timetable";

interface Props {
  infeasibleLecturers: LecturerFeasibility[];
  onContinueAnyway: () => void;
  onEditAvailability: () => void;
}

export function FeasibilityWarningStep({ infeasibleLecturers, onContinueAnyway, onEditAvailability }: Props) {
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />
        <div>
          <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
            {infeasibleLecturers.length} lecturer{infeasibleLecturers.length === 1 ? "" : "s"} may not
            physically fit their assigned workload
          </p>
          <p className="text-xs text-muted-foreground">
            Checked BEFORE running the generator — the total session time each lecturer below needs
            (converted to real shift lengths) is more than their own available day/shift windows can
            ever hold, so at least some of their sessions will land in Unscheduled no matter how hard
            the search tries. Fix the root cause below, or continue anyway if that&rsquo;s expected.
          </p>
        </div>
      </div>

      <div className="flex flex-col divide-y divide-border rounded-md border border-border bg-card">
        {infeasibleLecturers.map((check) => (
          <div key={check.lecturerId} className="flex flex-col gap-1 p-3">
            <p className="text-sm font-medium text-foreground">{check.lecturerName}</p>
            <p className="text-xs text-muted-foreground">{formatFeasibilityMessage(check)}</p>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
              <span className="text-muted-foreground">
                Required: <span className="font-medium text-foreground">{check.requiredHours}h</span>{" "}
                across {check.requiredBreakdown.length} course{check.requiredBreakdown.length === 1 ? "" : "s"}
              </span>
              <span className="text-muted-foreground">
                Available: <span className="font-medium text-foreground">{check.availableHours}h</span>
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" onClick={onEditAvailability}>
          Edit lecturer availability <ArrowRight className="size-4" />
        </Button>
        <Button type="button" variant="ghost" onClick={onContinueAnyway}>
          <CheckCircle2 className="size-4" />
          Continue anyway
        </Button>
      </div>
    </div>
  );
}
