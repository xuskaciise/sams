"use client";

import { X } from "lucide-react";
import type { DayOfWeek } from "@prisma/client";
import { Button } from "@/components/ui/button";
import {
  ScheduleGrid,
  type ScheduleGridRow,
  type ScheduleGridSession,
  type ScheduleGridChip,
  type ScheduleGridRoomOption,
} from "@/components/timetable/schedule-grid";
import type { ClassPreviewCounts } from "@/lib/auto-timetable-preview-state";

interface Props {
  className: string;
  rows: ScheduleGridRow[];
  days: DayOfWeek[];
  sessions: ScheduleGridSession[];
  chips: ScheduleGridChip[];
  counts: ClassPreviewCounts;
  roomOptions: ScheduleGridRoomOption[];
  errorCell: { rowId: string; day: DayOfWeek } | null;
  onScheduleChip: (chipId: string, day: DayOfWeek, row: ScheduleGridRow) => void;
  onMoveSession: (sessionId: string, day: DayOfWeek, row: ScheduleGridRow) => void;
  onUnscheduleSession: (sessionId: string) => void;
  onEditSessionTime: (sessionId: string, patch: { startTime?: string; endTime?: string }) => void;
  onEditSessionRoom: (sessionId: string, roomId: string) => void;
  // Manual, per-session, opt-in cross-period exception (see CLAUDE.md's
  // "Period" business rule) — empty for PT or a period-less FT class.
  // Full scale gets both drag-onto-a-cross-period-row AND the inline
  // checkbox/picker (see PlacedCard).
  crossPeriodRows: ScheduleGridRow[];
  onSetCrossPeriodOverride: (sessionId: string, allow: boolean) => void;
  onClose: () => void;
}

// Full-viewport, full-scale rendering of the exact same ScheduleGrid the
// mini card and the manual Build Timetable tool use — a thin,
// presentational wrapper only. It reads and writes the SAME live class
// state the mini card does (both owned by MultiClassOverview, which
// builds and passes down every prop here), just at full interactive
// scale with inline time/room editing on top of what the mini card
// offers. Nothing here writes to the DB, and there is nothing to "merge
// back" on close — a mini-card edit and a fullscreen edit are already
// the same underlying state, so opening/closing this modal never loses
// or duplicates anything either way (see the "mini-grid is now fully
// interactive" changelog entry in CLAUDE.md for the full reasoning).
export function ClassFullscreenModal({
  className: displayClassName,
  rows,
  days,
  sessions,
  chips,
  counts,
  roomOptions,
  errorCell,
  onScheduleChip,
  onMoveSession,
  onUnscheduleSession,
  onEditSessionTime,
  onEditSessionRoom,
  crossPeriodRows,
  onSetCrossPeriodOverride,
  onClose,
}: Props) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div>
          <p className="text-lg font-semibold">{displayClassName}</p>
          <p className="text-sm text-muted-foreground">
            {counts.scheduled} scheduled
            {counts.flagged > 0 ? `, ${counts.flagged} flagged` : ""}
            {counts.unscheduled > 0 ? `, ${counts.unscheduled} unscheduled` : ""} — drag a course onto a cell to
            schedule it, drag a placed session to move it, or drop it on the trash zone to unschedule it.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={onClose}>
          <X className="size-4" />
          Close
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <ScheduleGrid
          rows={rows}
          days={days}
          sessions={sessions}
          chips={chips}
          roomOptions={roomOptions}
          errorCell={errorCell}
          onScheduleChip={onScheduleChip}
          onMoveSession={onMoveSession}
          onUnscheduleSession={onUnscheduleSession}
          onEditSessionTime={onEditSessionTime}
          onEditSessionRoom={onEditSessionRoom}
          crossPeriodRows={crossPeriodRows}
          onSetCrossPeriodOverride={onSetCrossPeriodOverride}
        />
      </div>
    </div>
  );
}
