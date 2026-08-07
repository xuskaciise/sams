"use client";

// The "Lecturer availability" wizard step — shown once per semester-level
// batch, before the auto-generate algorithm ever runs for it. Lists every
// DISTINCT lecturer among that batch's schedulable assignments with an
// OPTIONAL per-day checkbox restriction; each CHECKED day expands to an
// optional shift multi-select scoped to that lecturer's own FT/PT shift
// set (leaving every shift box unchecked for a checked day means "every
// shift that day"). Pre-filled from any prior run's saved values, editable.
// Confirming saves fresh — this is deliberately re-entered every
// generation cycle, NOT a permanent Lecturer Registration field, since a
// lecturer's availability can change semester to semester. See CLAUDE.md's
// "Lecturer availableDays" business rule.

import { useState } from "react";
import { ChevronDown, ChevronRight, CheckCircle2, Loader2 } from "lucide-react";
import type { DayOfWeek } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  ALL_DAYS_ORDER,
  DAY_LABELS,
  type LecturerAvailabilityDayRule,
  type LecturerAvailabilityShiftRef,
} from "@/lib/timetable-days";
import type { LecturerAvailabilityUpdateInput } from "./schema";

export interface LecturerAvailabilityRow {
  lecturerId: string;
  lecturerName: string;
  availability: LecturerAvailabilityDayRule[];
  // This lecturer's own FT/PT shift catalog for the current batch (every
  // shift belonging to a studyMode any of their assignments in this batch
  // actually uses) — the day-expanded shift multi-select is scoped to
  // exactly this list, never the full cross-studyMode shift catalog.
  shiftOptions: LecturerAvailabilityShiftRef[];
}

// Per-lecturer, per-day local editing state: a day present in the inner
// Map means "checked" (available); its value is the set of selected
// shift ids for that day (empty = every shift that day).
type DayState = Map<DayOfWeek, Set<string>>;

function initialDayState(availability: LecturerAvailabilityDayRule[]): DayState {
  return new Map(availability.map((r) => [r.dayOfWeek, new Set(r.shifts.map((s) => s.id))]));
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
  const [stateByLecturer, setStateByLecturer] = useState<Map<string, DayState>>(
    () => new Map(lecturers.map((l) => [l.lecturerId, initialDayState(l.availability)]))
  );
  // Which lecturers have their day list expanded (open) — restricted
  // lecturers (from the pre-fill) start open so their existing restriction
  // is visible at a glance; unrestricted ones start collapsed to keep a
  // long roster scannable.
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(lecturers.filter((l) => l.availability.length > 0).map((l) => l.lecturerId))
  );
  const [saving, setSaving] = useState(false);

  function toggleExpanded(lecturerId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(lecturerId)) next.delete(lecturerId);
      else next.add(lecturerId);
      return next;
    });
  }

  function toggleDay(lecturerId: string, day: DayOfWeek, checked: boolean) {
    setStateByLecturer((prev) => {
      const next = new Map(prev);
      const days = new Map(next.get(lecturerId) ?? []);
      if (checked) days.set(day, new Set()); // default: whole day, no shift restriction yet
      else days.delete(day);
      next.set(lecturerId, days);
      return next;
    });
  }

  function toggleShift(lecturerId: string, day: DayOfWeek, shiftId: string, checked: boolean) {
    setStateByLecturer((prev) => {
      const next = new Map(prev);
      const days = new Map(next.get(lecturerId) ?? []);
      const shifts = new Set(days.get(day) ?? []);
      if (checked) shifts.add(shiftId);
      else shifts.delete(shiftId);
      days.set(day, shifts);
      next.set(lecturerId, days);
      return next;
    });
  }

  async function handleContinue() {
    setSaving(true);
    try {
      await onContinue(
        lecturers.map((l) => ({
          lecturerId: l.lecturerId,
          availability: [...(stateByLecturer.get(l.lecturerId) ?? new Map<DayOfWeek, Set<string>>())].map(([dayOfWeek, shiftIds]) => ({
            dayOfWeek,
            shiftIds: [...shiftIds],
          })),
        }))
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
          Optional, re-entered fresh for this generation run — a lecturer&rsquo;s availability can
          change every semester. Leave every day unchecked to keep a lecturer available every day/shift,
          as usual. Checking a day restricts scheduling to that day; within a checked day, leaving every
          shift unchecked means &ldquo;any shift that day&rdquo; — checking specific shifts narrows it
          further to just those. This is a HARD constraint: the algorithm (and the manual Builder) will
          never place a session for that lecturer outside what&rsquo;s checked here.
        </p>
      </div>

      <div className="flex flex-col divide-y divide-border rounded-md border border-border">
        {lecturers.map((l) => {
          const days = stateByLecturer.get(l.lecturerId) ?? new Map<DayOfWeek, Set<string>>();
          const isExpanded = expanded.has(l.lecturerId);
          const summary =
            days.size === 0
              ? "Every day/shift"
              : [...days.entries()]
                  .sort(([a], [b]) => ALL_DAYS_ORDER.indexOf(a) - ALL_DAYS_ORDER.indexOf(b))
                  .map(([day, shifts]) => `${DAY_LABELS[day].slice(0, 3)}${shifts.size > 0 ? ` (${shifts.size} shift${shifts.size === 1 ? "" : "s"})` : ""}`)
                  .join(", ");

          return (
            <div key={l.lecturerId} className="flex flex-col gap-2 p-3">
              <button
                type="button"
                onClick={() => toggleExpanded(l.lecturerId)}
                className="flex items-center justify-between gap-2 text-left"
              >
                <span className="flex items-center gap-1.5">
                  {isExpanded ? (
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="text-sm font-medium text-foreground">{l.lecturerName}</span>
                </span>
                <span className="text-xs text-muted-foreground">{summary}</span>
              </button>

              {isExpanded && (
                <div className="flex flex-col gap-2 pl-5">
                  {ALL_DAYS_ORDER.map((day) => {
                    const dayChecked = days.has(day);
                    const shiftsForDay = days.get(day) ?? new Set<string>();
                    return (
                      <div key={day} className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-1.5">
                          <Checkbox
                            id={`avail-${l.lecturerId}-${day}`}
                            checked={dayChecked}
                            onCheckedChange={(checked) => toggleDay(l.lecturerId, day, checked === true)}
                          />
                          <Label htmlFor={`avail-${l.lecturerId}-${day}`} className="text-xs font-normal">
                            {DAY_LABELS[day]}
                          </Label>
                        </div>
                        {dayChecked && l.shiftOptions.length > 0 && (
                          <div className="ml-5 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                            {l.shiftOptions.map((s) => (
                              <div key={s.id} className="flex items-center gap-1.5">
                                <Checkbox
                                  id={`avail-${l.lecturerId}-${day}-${s.id}`}
                                  checked={shiftsForDay.has(s.id)}
                                  onCheckedChange={(checked) => toggleShift(l.lecturerId, day, s.id, checked === true)}
                                />
                                <Label htmlFor={`avail-${l.lecturerId}-${day}-${s.id}`} className="text-xs font-normal">
                                  {s.name}
                                </Label>
                              </div>
                            ))}
                          </div>
                        )}
                        {dayChecked && l.shiftOptions.length === 0 && (
                          <p className="ml-5 text-xs text-muted-foreground">No shifts to narrow by — every shift that day.</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
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
