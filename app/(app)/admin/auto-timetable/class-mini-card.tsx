"use client";

import { Maximize2 } from "lucide-react";
import type { DayOfWeek } from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import { ScheduleGrid, type ScheduleGridRow, type ScheduleGridSession, type ScheduleGridChip } from "@/components/timetable/schedule-grid";
import type { ClassPreviewCounts } from "@/lib/auto-timetable-preview-state";

interface Props {
  className: string;
  rows: ScheduleGridRow[];
  days: DayOfWeek[];
  sessions: ScheduleGridSession[];
  chips: ScheduleGridChip[];
  counts: ClassPreviewCounts;
  errorCell: { rowId: string; day: DayOfWeek } | null;
  onExpand: () => void;
  onScheduleChip: (chipId: string, day: DayOfWeek, row: ScheduleGridRow) => void;
  onMoveSession: (sessionId: string, day: DayOfWeek, row: ScheduleGridRow) => void;
  onUnscheduleSession: (sessionId: string) => void;
  // Manual, per-session, opt-in cross-period exception (see CLAUDE.md's
  // "Period" business rule) — empty for PT or a period-less FT class.
  // Dragging a chip/session onto one of these extra rows is the only way
  // to set the override at THIS scale (no inline checkbox here — compact
  // never gets inline editing; expand to fullscreen for that).
  crossPeriodRows: ScheduleGridRow[];
}

// One card per class in the multi-class overview — a compact but FULLY
// interactive rendering of the exact same ScheduleGrid the fullscreen
// modal and the manual Build Timetable tool use (see
// components/timetable/schedule-grid.tsx's `scale`/`interactive` props
// and its compact-drag-and-drop rendering): drag a session to a
// different cell, drag an unscheduled chip from the tray above the grid
// onto an open cell, or tap a placed session's own small delete icon to
// unschedule it — all live, directly at card scale, going through the
// exact same conflict-checked handlers (owned by MultiClassOverview,
// shared with the fullscreen modal) as everywhere else. A rejected drop
// flashes the target cell red, same as at full scale. The expand icon
// stays available for a bigger, easier-to-work-with view — useful on a
// touch device, or when a card has many sessions crowding it — but is no
// longer required to make any edit here.
export function ClassMiniCard({
  className: displayClassName,
  rows,
  days,
  sessions,
  chips,
  counts,
  errorCell,
  onExpand,
  onScheduleChip,
  onMoveSession,
  onUnscheduleSession,
  crossPeriodRows,
}: Props) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{displayClassName}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
            <Badge variant="published" className="font-normal">
              {counts.scheduled} scheduled
            </Badge>
            {counts.flagged > 0 && (
              <Badge variant="draft" className="font-normal">
                {counts.flagged} flagged
              </Badge>
            )}
            {counts.unscheduled > 0 && (
              <Badge variant="destructive" className="font-normal">
                {counts.unscheduled} unscheduled
              </Badge>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onExpand}
          className="shrink-0 rounded-md border border-border p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={`Open ${displayClassName}'s full schedule`}
          title="Open full schedule"
        >
          <Maximize2 className="size-3.5" />
        </button>
      </div>
      <ScheduleGrid
        rows={rows}
        days={days}
        sessions={sessions}
        chips={chips}
        scale="compact"
        errorCell={errorCell}
        onScheduleChip={onScheduleChip}
        onMoveSession={onMoveSession}
        onUnscheduleSession={onUnscheduleSession}
        crossPeriodRows={crossPeriodRows}
      />
    </div>
  );
}
