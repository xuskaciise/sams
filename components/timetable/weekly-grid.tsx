"use client";

import type { DayOfWeek, StudyMode } from "@prisma/client";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { getValidDaysForStudyMode, DAY_LABELS } from "@/lib/timetable-days";

// Full-week fallback order (Saturday-first, matching this app's academic
// calendar) — used whenever the slots being shown span more than one
// studyMode (or none at all), since there's no single valid-days set to
// narrow to in that case.
const ALL_DAYS_ORDER: DayOfWeek[] = ["SAT", "SUN", "MON", "TUE", "WED", "THU", "FRI"];

export interface WeeklyGridSlot {
  id: string;
  dayOfWeek: DayOfWeek;
  startTime: string;
  endTime: string;
  courseName: string;
  className: string;
  lecturerName: string;
  roomName: string;
  // Optional: when every slot shares the SAME studyMode (a student's own
  // single class, or a lecturer whose classes are all one mode), the grid
  // narrows to only that mode's valid day columns (Sat-Wed for FT,
  // Thu-Fri for PT) instead of showing all 7. Omitted/mixed/null falls
  // back to the full week.
  studyMode?: StudyMode | null;
}

// Grouped-by-day columns rather than a pixel-positioned calendar, each
// column's slots sorted by start time. `onEdit`/`onDelete` are omitted
// entirely for read-only viewers (lecturer/student own-schedule pages),
// which also hides the per-card menu.
export function WeeklyGrid({
  slots,
  onEdit,
  onDelete,
}: {
  slots: WeeklyGridSlot[];
  onEdit?: (slot: WeeklyGridSlot) => void;
  onDelete?: (slot: WeeklyGridSlot) => void;
}) {
  const editable = !!(onEdit || onDelete);

  const distinctModes = new Set(
    slots.map((s) => s.studyMode).filter((m): m is StudyMode => !!m)
  );
  const days =
    distinctModes.size === 1
      ? (getValidDaysForStudyMode([...distinctModes][0]) ?? ALL_DAYS_ORDER)
      : ALL_DAYS_ORDER;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {days.map((day) => {
        const daySlots = slots
          .filter((s) => s.dayOfWeek === day)
          .sort((a, b) => a.startTime.localeCompare(b.startTime));

        return (
          <div key={day} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
            <p className="text-sm font-semibold">{DAY_LABELS[day]}</p>
            <div className="flex flex-col gap-2">
              {daySlots.map((slot) => (
                <div
                  key={slot.id}
                  className="rounded-md border border-border bg-muted/30 p-2 text-xs"
                >
                  <div className="flex items-start justify-between gap-1">
                    <p className="font-semibold text-foreground">
                      {slot.startTime}–{slot.endTime}
                    </p>
                    {editable && (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={<Button variant="ghost" size="icon-sm" className="-mt-1 -mr-1 h-6 w-6" />}
                        >
                          <MoreHorizontal className="size-3.5" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {onEdit && (
                            <DropdownMenuItem onClick={() => onEdit(slot)}>Edit</DropdownMenuItem>
                          )}
                          {onDelete && (
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => onDelete(slot)}
                            >
                              Delete
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                  <p className="mt-1 font-medium">{slot.courseName}</p>
                  <p className="text-muted-foreground">{slot.className}</p>
                  <p className="text-muted-foreground">{slot.lecturerName}</p>
                  <p className="text-muted-foreground">Room {slot.roomName}</p>
                </div>
              ))}
              {daySlots.length === 0 && (
                <p className="text-xs text-muted-foreground">No classes</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
