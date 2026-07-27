"use client";

import type { DayOfWeek } from "@prisma/client";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

const DAY_ORDER: DayOfWeek[] = ["MON", "TUE", "WED", "THU", "FRI", "SAT"];
const DAY_LABELS: Record<DayOfWeek, string> = {
  MON: "Monday",
  TUE: "Tuesday",
  WED: "Wednesday",
  THU: "Thursday",
  FRI: "Friday",
  SAT: "Saturday",
};

export interface WeeklyGridSlot {
  id: string;
  dayOfWeek: DayOfWeek;
  startTime: string;
  endTime: string;
  courseName: string;
  className: string;
  lecturerName: string;
  roomName: string;
}

// Grouped-by-day columns rather than a pixel-positioned calendar — MON-SAT
// side by side, each column's slots sorted by start time. `onEdit`/
// `onDelete` are omitted entirely for read-only viewers (lecturer/student
// own-schedule pages), which also hides the per-card menu.
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

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {DAY_ORDER.map((day) => {
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
