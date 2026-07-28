"use client";

import { Fragment } from "react";
import type { DayOfWeek, StudyMode } from "@prisma/client";
import { MoreHorizontal, User, MapPin, CalendarX2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { getValidDaysForStudyMode, DAY_LABELS, ALL_DAYS_ORDER } from "@/lib/timetable-days";

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

interface TimeRow {
  startTime: string;
  endTime: string;
}

// A real time-row/day-column grid (TIME down the left, days across the
// top) rather than day columns stacked independently — matches how a
// physical class timetable reads. There's no fixed "periods" concept in
// this app (Shifts are just an optional data-entry convenience, see
// lib/timetable-days.ts), so rows are the distinct start/end times
// actually present among the slots being shown, sorted chronologically —
// not a hardcoded schedule. A cell can (rarely) hold more than one slot —
// e.g. an unfiltered admin/dean view can show two different classes
// booked at the same day+time in different rooms, which is normal, not a
// conflict — so cells stack their card(s) vertically instead of assuming
// exactly one.
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

  const rowMap = new Map<string, TimeRow>();
  for (const s of slots) {
    const key = `${s.startTime}-${s.endTime}`;
    if (!rowMap.has(key)) rowMap.set(key, { startTime: s.startTime, endTime: s.endTime });
  }
  const rows = [...rowMap.values()].sort(
    (a, b) => a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime)
  );

  function slotsFor(day: DayOfWeek, row: TimeRow) {
    return slots.filter(
      (s) => s.dayOfWeek === day && s.startTime === row.startTime && s.endTime === row.endTime
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="overflow-x-auto">
        <div
          className="grid"
          style={{
            gridTemplateColumns: `100px repeat(${days.length}, minmax(150px, 1fr))`,
            minWidth: `${100 + days.length * 150}px`,
          }}
        >
          <div className="flex items-center justify-center border-b border-border bg-primary/5 px-2 py-2.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Time
          </div>
          {days.map((day, i) => (
            <div
              key={day}
              className="flex flex-col items-center gap-0.5 border-b border-l border-border bg-primary/5 px-2 py-2.5"
            >
              <p className="text-sm font-semibold">{DAY_LABELS[day]}</p>
              <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                Day {i + 1}
              </p>
            </div>
          ))}

          {rows.map((row) => (
            <Fragment key={`${row.startTime}-${row.endTime}`}>
              <div className="flex flex-col items-center justify-center gap-1 border-b border-border px-2 py-3">
                <p className="text-sm font-semibold text-primary">{row.startTime}</p>
                <div className="h-3 w-px bg-border" />
                <p className="text-sm font-semibold text-primary">{row.endTime}</p>
              </div>
              {days.map((day) => {
                const cellSlots = slotsFor(day, row);
                return (
                  <div key={day} className="flex flex-col gap-1.5 border-b border-l border-border p-2">
                    {cellSlots.map((slot) => (
                      <div
                        key={slot.id}
                        className="rounded-lg border border-border border-l-4 border-l-primary bg-muted/20 p-2 text-xs"
                      >
                        <div className="flex items-start justify-between gap-1">
                          <p className="font-semibold text-foreground">{slot.courseName}</p>
                          {editable && (
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                render={
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    className="-mt-1 -mr-1 h-5 w-5 shrink-0"
                                  />
                                }
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
                        <p className="text-muted-foreground">{slot.className}</p>
                        <div className="mt-1 flex items-center gap-1 text-muted-foreground">
                          <User className="size-3 shrink-0" />
                          <span className="truncate">{slot.lecturerName}</span>
                        </div>
                        <Badge variant="secondary" className="mt-1 gap-1 font-normal">
                          <MapPin className="size-3" />
                          {slot.roomName}
                        </Badge>
                      </div>
                    ))}
                    {cellSlots.length === 0 && (
                      <div className="flex flex-1 items-center justify-center py-2 text-muted-foreground/50">
                        <CalendarX2 className="size-4" />
                      </div>
                    )}
                  </div>
                );
              })}
            </Fragment>
          ))}

          {rows.length === 0 && (
            <div
              className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground"
              style={{ gridColumn: `1 / span ${days.length + 1}` }}
            >
              <CalendarX2 className="size-6" />
              <p className="text-sm">No classes scheduled</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
