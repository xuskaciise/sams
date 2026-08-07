"use client";

// The "Lecturer availability" wizard step — shown once per semester-level
// batch, before the auto-generate algorithm ever runs for it. Lists every
// DISTINCT lecturer among that batch's schedulable assignments with an
// OPTIONAL per-day checkbox restriction, pre-filled from whatever
// Lecturer.availableDays currently holds (from a prior generation run, if
// any). Confirming saves every lecturer's chosen days fresh — this is
// deliberately re-entered every generation cycle, NOT a permanent Lecturer
// Registration field, since a lecturer's availability can change semester
// to semester. See CLAUDE.md's "Lecturer availableDays" business rule.

import { useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import type { DayOfWeek } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ALL_DAYS_ORDER, DAY_LABELS } from "@/lib/timetable-days";
import type { LecturerAvailabilityUpdateInput } from "./schema";

export interface LecturerAvailabilityRow {
  lecturerId: string;
  lecturerName: string;
  availableDays: DayOfWeek[];
}

interface Props {
  lecturers: LecturerAvailabilityRow[];
  onContinue: (updates: LecturerAvailabilityUpdateInput[]) => Promise<void>;
}

export function LecturerAvailabilityStep({ lecturers, onContinue }: Props) {
  // Keyed by lecturerId, initialized once from the pre-filled prop — this
  // whole component is remounted (via a `key` on the semester-level) by
  // the parent whenever a different level's lecturer set is shown, so
  // there's no stale-state-across-levels risk from only initializing once
  // here.
  const [daysByLecturer, setDaysByLecturer] = useState<Map<string, DayOfWeek[]>>(
    () => new Map(lecturers.map((l) => [l.lecturerId, l.availableDays]))
  );
  const [saving, setSaving] = useState(false);

  function toggleDay(lecturerId: string, day: DayOfWeek, checked: boolean) {
    setDaysByLecturer((prev) => {
      const next = new Map(prev);
      const current = next.get(lecturerId) ?? [];
      next.set(lecturerId, checked ? [...current, day] : current.filter((d) => d !== day));
      return next;
    });
  }

  async function handleContinue() {
    setSaving(true);
    try {
      await onContinue(
        lecturers.map((l) => ({ lecturerId: l.lecturerId, availableDays: daysByLecturer.get(l.lecturerId) ?? [] }))
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
      <div>
        <p className="text-sm font-semibold">Lecturer availability</p>
        <p className="text-xs text-muted-foreground">
          Optional, re-entered fresh for this generation run — a lecturer&rsquo;s available days can
          change every semester. Leave every box unchecked to keep a lecturer available every day, as
          usual. Checking any day is a HARD constraint: the algorithm (and the manual Builder) will
          never place a session for that lecturer outside the checked days.
        </p>
      </div>

      <div className="flex flex-col divide-y divide-border rounded-md border border-border">
        {lecturers.map((l) => {
          const value = daysByLecturer.get(l.lecturerId) ?? [];
          return (
            <div key={l.lecturerId} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm font-medium text-foreground sm:w-48 sm:shrink-0">{l.lecturerName}</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
                {ALL_DAYS_ORDER.map((day) => (
                  <div key={day} className="flex items-center gap-1.5">
                    <Checkbox
                      id={`avail-${l.lecturerId}-${day}`}
                      checked={value.includes(day)}
                      onCheckedChange={(checked) => toggleDay(l.lecturerId, day, checked === true)}
                    />
                    <Label htmlFor={`avail-${l.lecturerId}-${day}`} className="text-xs font-normal">
                      {DAY_LABELS[day].slice(0, 3)}
                    </Label>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {lecturers.length === 0 && (
          <p className="p-3 text-xs text-muted-foreground">No lecturers to configure for this batch.</p>
        )}
      </div>

      <Button type="button" onClick={handleContinue} disabled={saving} className="self-start">
        {saving ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
        Continue to generate timetable
      </Button>
    </div>
  );
}
