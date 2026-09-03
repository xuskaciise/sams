"use client";

// Generic Shift-rows x Day-columns schedule grid, shared by every place
// this app renders a class's week of sessions as a grid: the manual
// "Build Timetable" drag-and-drop tool (admin/timetable/
// build-timetable-client.tsx), the auto-timetable generator's per-class
// mini overview cards (compact scale, but FULLY interactive — see the
// `compact` interactive rendering below), and that same generator's
// per-class fullscreen review modal (full scale, interactive). All three
// are backed by local preview state rather than live Server Actions
// except the manual builder. See CLAUDE.md's "Workload Excel import +
// auto-timetable generation" business rule.
//
// This component owns ONLY presentation + drag-and-drop wiring — it has
// no idea whether a drop should write to the DB or to local React state.
// Callers supply plain data (`rows`/`sessions`/`chips`) and callbacks;
// every side effect happens in the caller's own handlers.

import { useState } from "react";
import {
  DndContext,
  useDraggable,
  useDroppable,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { GripVertical, User, MapPin, Clock, Trash2, Loader2, Pencil, Shuffle, ChevronDown, ChevronUp, MoreHorizontal } from "lucide-react";
import type { DayOfWeek } from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { DAY_LABELS, isShiftAllowedForLecturerOnDay, type LecturerAvailabilityDayRule } from "@/lib/timetable-days";

export interface ScheduleGridRow {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  // True for a row representing the OTHER period's shift — only ever
  // included by a caller in `crossPeriodRows` (see ScheduleGridProps),
  // never in the normal `rows` list, and only for an FT class with a
  // period set. See CLAUDE.md's "Period" business rule's "cross-period
  // override" bullet.
  crossPeriod?: boolean;
}

export interface ScheduleGridSession {
  id: string;
  assignmentId: string;
  courseName: string;
  lecturerName: string;
  // OPTIONAL hard scheduling constraint, day+shift granularity (see
  // LecturerAvailability in schema.prisma) — empty/omitted means
  // unrestricted, exactly today's behavior. When non-empty, dragging THIS
  // session greys out (and disables dropping onto) every (day, shift)
  // CELL not allowed for this lecturer — a whole day-column when that
  // day has no rule at all, or just the non-listed shift-ROWS within a
  // day that has a shift-level restriction — for the duration of that one
  // drag only. See ScheduleGrid's activeDrag handling below. Never
  // affects cells for a DIFFERENT lecturer's session in the same grid.
  lecturerAvailability?: LecturerAvailabilityDayRule[];
  roomLabel: string;
  dayOfWeek: DayOfWeek;
  startTime: string;
  endTime: string;
  // Read-only report grids only (the Timetable "super filter" view): a
  // live "in progress now" / "up next" marker, shown as a badge + accent
  // WITHIN the session's grid cell. Never set by the interactive builder
  // or the auto-generate preview.
  status?: "NOW" | "NEXT";
  // Shown under the course name when a single grid combines sessions from
  // several classes (the report view's structure-group grids). Omitted
  // when every session in the grid is the same class.
  className?: string;
  // Visually flagged — used for a spacing-fallback placement (see
  // generateTimetableForBatch) so it reads differently from a normal one
  // at a glance, at every scale.
  flagged?: boolean;
  flagNote?: string;
  busy?: boolean;
  // Shown as a small "override" badge next to the room label — the
  // caller decides what counts as an override (e.g. differs from the
  // class's main room). Full scale only (compact never shows room).
  roomOverride?: boolean;
  // Manual, per-session, opt-in exception — this ONE session deliberately
  // uses a shift from the OTHER period than its class's own. Flagged
  // visually (distinct from the `flagged`/spacing-fallback treatment) at
  // every scale. Never set automatically — see CLAUDE.md's "Period"
  // business rule's "cross-period override" bullet.
  crossPeriodOverride?: boolean;
}

export interface ScheduleGridChip {
  id: string;
  assignmentId: string;
  courseName: string;
  lecturerName: string;
  // Same OPTIONAL hard constraint as ScheduleGridSession.lecturerAvailability
  // — applies while dragging this unscheduled chip too, not just an
  // already-placed session.
  lecturerAvailability?: LecturerAvailabilityDayRule[];
  badge?: string;
}

export interface ScheduleGridRoomOption {
  value: string;
  label: string;
  keywords?: string[];
}

const TRASH_ID = "schedule-grid-trash";

function cellId(rowId: string, day: DayOfWeek) {
  return `cell:${rowId}:${day}`;
}

// A placed session's grid ROW is resolved by whichever row's [start, end)
// window contains its own startTime — or, if a custom time has moved it
// outside every window, the row with the closest start time. Same
// heuristic build-timetable-client.tsx already used (there is no FK from
// a session to a row/Shift — see CLAUDE.md's Shifts section).
function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function rowForSession(session: Pick<ScheduleGridSession, "startTime">, rows: ScheduleGridRow[]): ScheduleGridRow | null {
  if (rows.length === 0) return null;
  const t = timeToMinutes(session.startTime);
  const contained = rows.find((r) => t >= timeToMinutes(r.startTime) && t < timeToMinutes(r.endTime));
  if (contained) return contained;
  return [...rows].sort((a, b) => Math.abs(timeToMinutes(a.startTime) - t) - Math.abs(timeToMinutes(b.startTime) - t))[0];
}

interface DraggableChipProps {
  chip: ScheduleGridChip;
  compact?: boolean;
}

function DraggableChip({ chip, compact }: DraggableChipProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `chip:${chip.id}`,
    data: { type: "chip" as const, chipId: chip.id },
  });

  // Compact: a single small pill, drag-initiated from the WHOLE chip (not
  // a separate handle icon) — the same "make the whole small target
  // draggable, not just a tiny icon within it" reasoning as the compact
  // PlacedCard below, since a card-scale drag handle icon alone would be
  // a genuinely hard target to grab accurately.
  if (compact) {
    return (
      <div
        ref={setNodeRef}
        {...listeners}
        {...attributes}
        title={`${chip.courseName} — ${chip.lecturerName}${chip.badge ? ` (${chip.badge})` : ""}`}
        className={`max-w-full cursor-grab touch-none truncate rounded-md border border-dashed border-border bg-muted/40 px-1.5 py-1 text-[10px] font-medium text-foreground active:cursor-grabbing ${
          isDragging ? "opacity-40" : ""
        }`}
        style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined}
      >
        {chip.courseName}
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`flex cursor-grab items-center gap-2 rounded-lg border border-border bg-card p-2.5 text-xs active:cursor-grabbing ${
        isDragging ? "opacity-40" : ""
      }`}
      style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined}
    >
      <GripVertical className="size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold text-foreground">{chip.courseName}</p>
        <p className="truncate text-muted-foreground">{chip.lecturerName}</p>
      </div>
      {chip.badge && (
        <Badge variant="secondary" className="shrink-0 font-normal">
          {chip.badge}
        </Badge>
      )}
    </div>
  );
}

interface PlacedCardProps {
  session: ScheduleGridSession;
  roomOptions?: ScheduleGridRoomOption[];
  onEditTime?: (patch: { startTime?: string; endTime?: string }) => void;
  onEditRoom?: (roomId: string) => void;
  onUnschedule?: () => void;
  // Read-only report grids: a small ⋯ Edit/Delete menu, shown even when
  // the grid isn't interactive (there's no drag here — this just reopens
  // the existing single-slot Add/Edit dialog / delete flow).
  onEdit?: () => void;
  onDelete?: () => void;
  disabled?: boolean;
  compact?: boolean;
  // The manual cross-period override toggle (full scale only — see
  // ClassMiniCard's own doc comment for why compact never gets inline
  // editing). Only provided by the caller when the class is FT with a
  // period set; `crossPeriodShiftOptions` is the OTHER period's Shift
  // list, offered as a picker once the checkbox is on — picking one fills
  // the time fields via `onEditTime`, same "shift-pick is a time autofill
  // convenience" pattern as everywhere else in this app.
  onSetCrossPeriodOverride?: (allow: boolean) => void;
  crossPeriodShiftOptions?: ScheduleGridRow[];
}

function PlacedCard({
  session,
  roomOptions,
  onEditTime,
  onEditRoom,
  onUnschedule,
  onEdit,
  onDelete,
  disabled,
  compact,
  onSetCrossPeriodOverride,
  crossPeriodShiftOptions,
}: PlacedCardProps) {
  const [editingTime, setEditingTime] = useState(false);
  const [editingRoom, setEditingRoom] = useState(false);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `session:${session.id}`,
    data: { type: "session" as const, sessionId: session.id },
    disabled: disabled || session.busy,
  });

  // Compact: one small pill per session, drag-initiated from the WHOLE
  // pill (not a separate ~10px handle icon) — a real usability concern at
  // card scale, since a tiny dedicated drag-handle icon would be a hard
  // target to grab accurately (especially on touch). No inline time/room
  // editing at this scale (there simply isn't room for it); "delete" is a
  // small tap target on the pill itself rather than drag-to-trash, which
  // would be an even less forgiving gesture this small — see
  // ClassMiniCard's own doc comment for the full reasoning.
  if (compact) {
    return (
      <div
        ref={setNodeRef}
        {...(disabled ? {} : listeners)}
        {...(disabled ? {} : attributes)}
        title={`${session.courseName} — ${session.lecturerName} (${session.startTime}–${session.endTime})${
          session.flagged ? " — spacing fallback, review recommended" : ""
        }${session.crossPeriodOverride ? " — cross-period override" : ""}`}
        className={`flex items-center gap-1 rounded border-l-2 bg-card px-1.5 py-1 text-[10px] leading-tight ${
          disabled ? "" : "cursor-grab touch-none active:cursor-grabbing"
        } ${
          session.status === "NOW"
            ? "border-l-green-500 bg-green-500/10"
            : session.flagged
              ? "border-l-amber-500 bg-amber-500/10"
              : session.crossPeriodOverride
                ? "border-l-violet-500 bg-violet-500/10"
                : "border-l-primary"
        } ${isDragging ? "opacity-40" : ""} ${session.busy ? "opacity-60" : ""}`}
        style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined}
      >
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{session.courseName}</span>
        {session.busy ? (
          <Loader2 className="size-2.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          onUnschedule && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onUnschedule}
              className="shrink-0 text-muted-foreground hover:text-destructive"
              aria-label="Unschedule"
            >
              <Trash2 className="size-2.5" />
            </button>
          )
        )}
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col gap-1.5 rounded-lg border border-border border-l-4 bg-card p-2 text-xs ${
        session.status === "NOW"
          ? "border-l-green-500"
          : session.flagged
            ? "border-l-amber-500"
            : session.crossPeriodOverride
              ? "border-l-violet-500"
              : "border-l-primary"
      } ${isDragging ? "opacity-40" : ""} ${session.busy ? "opacity-60" : ""}`}
      style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined}
    >
      <div className="flex items-start gap-1.5">
        {!disabled && (
          <button
            type="button"
            {...listeners}
            {...attributes}
            className="mt-0.5 shrink-0 cursor-grab touch-none text-muted-foreground active:cursor-grabbing"
            aria-label="Drag to move"
          >
            <GripVertical className="size-3.5" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {session.status === "NOW" && (
              <Badge variant="published" className="shrink-0">NOW</Badge>
            )}
            {session.status === "NEXT" && (
              <Badge variant="outline" className="shrink-0">NEXT</Badge>
            )}
            <p className="truncate font-semibold text-foreground">{session.courseName}</p>
          </div>
          {session.className && (
            <p className="truncate text-muted-foreground">{session.className}</p>
          )}
          <span className="flex items-center gap-1 text-muted-foreground">
            <User className="size-3 shrink-0" />
            <span className="truncate">{session.lecturerName}</span>
          </span>
        </div>
        {session.busy ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : onUnschedule ? (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onUnschedule}
            className="shrink-0 text-muted-foreground hover:text-destructive"
            aria-label="Unschedule"
          >
            <Trash2 className="size-3.5" />
          </button>
        ) : (
          (onEdit || onDelete) && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="-mr-1 -mt-1 size-6 shrink-0" />}>
                <MoreHorizontal className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onEdit && <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem>}
                {onDelete && (
                  <DropdownMenuItem variant="destructive" onClick={onDelete}>
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )
        )}
      </div>

      {session.flagged && (
        <p className="text-amber-700 dark:text-amber-400">
          {session.flagNote ?? "Placed via spacing fallback — review recommended."}
        </p>
      )}

      {session.crossPeriodOverride && (
        <p className="flex items-center gap-1 text-violet-700 dark:text-violet-400">
          <Shuffle className="size-3 shrink-0" />
          Cross-period override
        </p>
      )}

      {onEditTime ? (
        editingTime ? (
          <div onPointerDown={(e) => e.stopPropagation()} className="flex items-center gap-1">
            <Input
              type="time"
              defaultValue={session.startTime}
              className="h-6 px-1 text-[11px]"
              onBlur={(e) => onEditTime({ startTime: e.target.value })}
            />
            <span className="text-muted-foreground">–</span>
            <Input
              type="time"
              defaultValue={session.endTime}
              className="h-6 px-1 text-[11px]"
              onBlur={(e) => onEditTime({ endTime: e.target.value })}
            />
            <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setEditingTime(false)}>
              Done
            </button>
          </div>
        ) : (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setEditingTime(true)}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            <Clock className="size-3 shrink-0" />
            {session.startTime}–{session.endTime}
            <Pencil className="size-2.5 shrink-0" />
          </button>
        )
      ) : (
        <span className="flex items-center gap-1 text-muted-foreground">
          <Clock className="size-3 shrink-0" />
          {session.startTime}–{session.endTime}
        </span>
      )}

      {onEditRoom && roomOptions ? (
        editingRoom ? (
          <div onPointerDown={(e) => e.stopPropagation()} className="flex items-center gap-1">
            <SearchableSelect
              value=""
              onValueChange={(value) => {
                onEditRoom(value);
                setEditingRoom(false);
              }}
              items={roomOptions}
              placeholder="Room"
              searchPlaceholder="Search rooms…"
              className="w-full"
            />
          </div>
        ) : (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setEditingRoom(true)}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            <MapPin className="size-3 shrink-0" />
            <span className="truncate">{session.roomLabel}</span>
            {session.roomOverride && (
              <Badge variant="outline" className="ml-auto shrink-0 font-normal">
                override
              </Badge>
            )}
          </button>
        )
      ) : (
        <span className="flex items-center gap-1 text-muted-foreground">
          <MapPin className="size-3 shrink-0" />
          <span className="truncate">{session.roomLabel}</span>
          {session.roomOverride && (
            <Badge variant="outline" className="ml-auto shrink-0 font-normal">
              override
            </Badge>
          )}
        </span>
      )}

      {/* Manual, per-session, opt-in exception — only rendered when the
          caller supplies onSetCrossPeriodOverride (an FT class with a
          period set; PT/no-period classes never get this control at all,
          since there is no "other period" for them). The checkbox alone
          just flags the session as intentional; the picker beneath it
          (offered once checked) is the convenience for actually choosing
          an other-period shift's time — picking one fills the time
          fields the same way every other shift-pick in this app does. */}
      {onSetCrossPeriodOverride && (
        <div onPointerDown={(e) => e.stopPropagation()} className="flex flex-col gap-1 border-t border-border pt-1.5">
          <label className="flex items-center gap-1.5 text-muted-foreground">
            <input
              type="checkbox"
              checked={!!session.crossPeriodOverride}
              onChange={(e) => onSetCrossPeriodOverride(e.target.checked)}
              className="size-3 accent-violet-600"
            />
            Cross-period override
          </label>
          {session.crossPeriodOverride && crossPeriodShiftOptions && crossPeriodShiftOptions.length > 0 && onEditTime && (
            <select
              defaultValue=""
              onChange={(e) => {
                const shift = crossPeriodShiftOptions.find((s) => s.id === e.target.value);
                if (shift) onEditTime({ startTime: shift.startTime, endTime: shift.endTime });
                e.target.value = "";
              }}
              className="h-6 rounded border border-input bg-transparent px-1 text-[11px] text-foreground"
            >
              <option value="" disabled>
                Use a cross-period shift…
              </option>
              {crossPeriodShiftOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.startTime}–{s.endTime})
                </option>
              ))}
            </select>
          )}
        </div>
      )}
    </div>
  );
}

interface CompactSessionChipProps {
  session: ScheduleGridSession;
}

// Static, non-draggable — only ever used for a genuinely read-only
// compact grid (scale="compact" with interactive={false}). The
// auto-generate overview's mini cards no longer use this path (they're
// interactive now); it's kept for any future read-only-at-a-glance use.
function CompactSessionChip({ session }: CompactSessionChipProps) {
  return (
    <div
      className={`truncate rounded border-l-2 bg-card px-1 py-0.5 text-[10px] leading-tight ${
        session.flagged
          ? "border-l-amber-500 bg-amber-500/10"
          : session.crossPeriodOverride
            ? "border-l-violet-500 bg-violet-500/10"
            : "border-l-primary"
      }`}
      title={`${session.courseName} — ${session.lecturerName} (${session.startTime}–${session.endTime})${
        session.flagged ? " — spacing fallback" : ""
      }${session.crossPeriodOverride ? " — cross-period override" : ""}`}
    >
      <span className="font-medium text-foreground">{session.courseName}</span>
    </div>
  );
}

interface GridCellProps {
  row: ScheduleGridRow;
  day: DayOfWeek;
  sessions: ScheduleGridSession[];
  scale: "full" | "compact";
  interactive: boolean;
  roomOptions?: ScheduleGridRoomOption[];
  errorFlash: boolean;
  // True while the item currently being dragged belongs to a lecturer
  // whose availability excludes THIS specific (row's shift, day) CELL —
  // greys the cell out and disables it as a drop target for the duration
  // of that one drag. A day-level-only restriction blocks every cell in
  // that day-column; a day+shift restriction blocks only the non-listed
  // shift-rows within that one day.
  restrictedCellBlocked: boolean;
  onEditSessionTime?: (sessionId: string, patch: { startTime?: string; endTime?: string }) => void;
  onEditSessionRoom?: (sessionId: string, roomId: string) => void;
  onUnscheduleSession?: (sessionId: string) => void;
  onEditSession?: (sessionId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  onSetCrossPeriodOverride?: (sessionId: string, allow: boolean) => void;
  crossPeriodShiftOptions?: ScheduleGridRow[];
}

function GridCell({
  row,
  day,
  sessions,
  scale,
  interactive,
  roomOptions,
  errorFlash,
  restrictedCellBlocked,
  onEditSessionTime,
  onEditSessionRoom,
  onUnscheduleSession,
  onEditSession,
  onDeleteSession,
  onSetCrossPeriodOverride,
  crossPeriodShiftOptions,
}: GridCellProps) {
  const droppableEnabled = interactive && !restrictedCellBlocked;
  const droppable = useDroppable({
    id: cellId(row.id, day),
    data: { type: "cell" as const, rowId: row.id, day },
    disabled: !droppableEnabled,
  });

  const compact = scale === "compact";

  return (
    <div
      ref={droppableEnabled ? droppable.setNodeRef : undefined}
      title={restrictedCellBlocked ? "This lecturer is not available for this shift/day" : undefined}
      className={`flex flex-col gap-1 border-b border-l border-border p-1 transition-colors ${
        compact ? "min-h-9" : "min-h-20 gap-1.5 p-1.5"
      } ${
        errorFlash
          ? "bg-destructive/15"
          : restrictedCellBlocked
            ? "cursor-not-allowed bg-muted/60 opacity-50"
            : droppableEnabled && droppable.isOver
              ? "bg-primary/10"
              : row.crossPeriod
                ? "bg-violet-500/5"
                : ""
      }`}
    >
      {sessions.map((session) =>
        compact && !interactive ? (
          // Read-only compact — see CompactSessionChip's own doc comment.
          <CompactSessionChip key={session.id} session={session} />
        ) : (
          <PlacedCard
            key={session.id}
            session={session}
            roomOptions={roomOptions}
            disabled={!interactive}
            compact={compact}
            onEditTime={interactive && !compact && onEditSessionTime ? (patch) => onEditSessionTime(session.id, patch) : undefined}
            onEditRoom={interactive && !compact && onEditSessionRoom ? (roomId) => onEditSessionRoom(session.id, roomId) : undefined}
            onUnschedule={interactive && onUnscheduleSession ? () => onUnscheduleSession(session.id) : undefined}
            onEdit={!compact && onEditSession ? () => onEditSession(session.id) : undefined}
            onDelete={!compact && onDeleteSession ? () => onDeleteSession(session.id) : undefined}
            onSetCrossPeriodOverride={
              interactive && !compact && onSetCrossPeriodOverride ? (allow) => onSetCrossPeriodOverride(session.id, allow) : undefined
            }
            crossPeriodShiftOptions={crossPeriodShiftOptions}
          />
        )
      )}
    </div>
  );
}

function TrashDropZone() {
  const { setNodeRef, isOver } = useDroppable({ id: TRASH_ID, data: { type: "trash" as const } });
  return (
    <div
      ref={setNodeRef}
      className={`flex items-center justify-center gap-2 rounded-lg border border-dashed p-3 text-xs transition-colors ${
        isOver ? "border-destructive bg-destructive/10 text-destructive" : "border-border text-muted-foreground"
      }`}
    >
      <Trash2 className="size-3.5" />
      Drag here to unschedule
    </div>
  );
}

export interface ScheduleGridProps {
  rows: ScheduleGridRow[];
  days: DayOfWeek[];
  sessions: ScheduleGridSession[];
  // "full" (default) is the manual builder's/fullscreen modal's real
  // scale; "compact" is the smaller rendering used by the auto-generate
  // overview's mini cards. Compact is fully interactive-capable — pass
  // `interactive={false}` (the mini cards used to, no longer do) for a
  // genuinely read-only compact rendering instead.
  scale?: "full" | "compact";
  interactive?: boolean;
  chips?: ScheduleGridChip[];
  roomOptions?: ScheduleGridRoomOption[];
  errorCell?: { rowId: string; day: DayOfWeek } | null;
  onScheduleChip?: (chipId: string, day: DayOfWeek, row: ScheduleGridRow) => void;
  onMoveSession?: (sessionId: string, day: DayOfWeek, row: ScheduleGridRow) => void;
  onUnscheduleSession?: (sessionId: string) => void;
  onEditSessionTime?: (sessionId: string, patch: { startTime?: string; endTime?: string }) => void;
  onEditSessionRoom?: (sessionId: string, roomId: string) => void;
  // Read-only report grids (interactive={false}): a ⋯ Edit/Delete menu on
  // each full-scale card, reopening the existing single-slot dialog /
  // delete flow. No drag — this is not a scheduling affordance.
  onEditSession?: (sessionId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  // Manual, per-session, opt-in cross-period exception (see CLAUDE.md's
  // "Period" business rule's "cross-period override" bullet) — omitted
  // entirely (undefined/empty) for a PT class or an FT class with no
  // period set, since there's no "other period" to offer. When provided,
  // a small "Show cross-period shifts" toggle appears above the grid;
  // turning it on ADDS these as extra rows (visually tinted, never mixed
  // in silently) — dropping a chip or moving a session onto one of them
  // is what actually marks it (the row IS the intent signal; see
  // scheduleChipInClass/moveSessionInClass). The SAME list doubles as the
  // options for each placed session's own inline cross-period picker
  // (full scale only — see PlacedCard).
  crossPeriodRows?: ScheduleGridRow[];
  onSetCrossPeriodOverride?: (sessionId: string, allow: boolean) => void;
  className?: string;
}

export function ScheduleGrid({
  rows: ownRows,
  days,
  sessions,
  scale = "full",
  interactive = true,
  chips,
  roomOptions,
  errorCell,
  onScheduleChip,
  onMoveSession,
  onUnscheduleSession,
  onEditSessionTime,
  onEditSessionRoom,
  onEditSession,
  onDeleteSession,
  crossPeriodRows,
  onSetCrossPeriodOverride,
  className,
}: ScheduleGridProps) {
  const [activeDrag, setActiveDrag] = useState<
    { type: "chip"; chip: ScheduleGridChip } | { type: "session"; session: ScheduleGridSession } | null
  >(null);
  const [showCrossPeriod, setShowCrossPeriod] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const compact = scale === "compact";
  const rowLabelWidth = compact ? 88 : 140;
  const dayColWidth = compact ? 92 : 150;
  // Own-period rows are ALWAYS shown; the other period's rows only join
  // them once explicitly toggled on — the default view never mixes them
  // in, matching "default behavior stays unchanged."
  const rows = showCrossPeriod && crossPeriodRows ? [...ownRows, ...crossPeriodRows] : ownRows;

  // The currently-dragged chip/session's lecturer availability rules, if
  // it has any set — null when nothing is being dragged OR the dragged
  // item's lecturer is unrestricted, in which case every (day, shift)
  // cell stays fully droppable exactly as before this feature.
  const activeLecturerAvailability: LecturerAvailabilityDayRule[] | null =
    activeDrag?.type === "chip"
      ? activeDrag.chip.lecturerAvailability?.length
        ? activeDrag.chip.lecturerAvailability
        : null
      : activeDrag?.type === "session"
        ? activeDrag.session.lecturerAvailability?.length
          ? activeDrag.session.lecturerAvailability
          : null
        : null;

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current;
    if (data?.type === "chip" && chips) {
      const chip = chips.find((c) => c.id === data.chipId);
      if (chip) setActiveDrag({ type: "chip", chip });
    } else if (data?.type === "session") {
      const s = sessions.find((sx) => sx.id === data.sessionId);
      if (s) setActiveDrag({ type: "session", session: s });
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDrag(null);
    const { active, over } = event;
    if (!over) return;
    const activeData = active.data.current;
    const overData = over.data.current;
    if (!activeData || !overData) return;

    if (overData.type === "trash") {
      if (activeData.type === "session" && onUnscheduleSession) onUnscheduleSession(activeData.sessionId);
      return;
    }

    if (overData.type === "cell") {
      const row = rows.find((r) => r.id === overData.rowId);
      if (!row) return;
      if (activeData.type === "chip" && onScheduleChip) {
        onScheduleChip(activeData.chipId, overData.day, row);
      } else if (activeData.type === "session" && onMoveSession) {
        onMoveSession(activeData.sessionId, overData.day, row);
      }
    }
  }

  const grid = (
    <div className={`flex min-w-0 flex-1 flex-col gap-1.5 ${className ?? ""}`}>
      {interactive && crossPeriodRows && crossPeriodRows.length > 0 && (
        <button
          type="button"
          onClick={() => setShowCrossPeriod((v) => !v)}
          className={`flex w-fit items-center gap-1 self-start rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
            showCrossPeriod
              ? "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-400"
              : "border-border text-muted-foreground hover:bg-muted"
          }`}
        >
          <Shuffle className="size-3 shrink-0" />
          {showCrossPeriod ? "Hide" : "Show"} cross-period shifts ({crossPeriodRows.length})
          {showCrossPeriod ? <ChevronUp className="size-3 shrink-0" /> : <ChevronDown className="size-3 shrink-0" />}
        </button>
      )}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="overflow-x-auto">
        <div
          className="grid"
          style={{
            gridTemplateColumns: `${rowLabelWidth}px repeat(${days.length}, minmax(${dayColWidth}px, 1fr))`,
            minWidth: `${rowLabelWidth + days.length * dayColWidth}px`,
          }}
        >
          <div
            className={`flex items-center justify-center border-b border-border bg-primary/5 font-semibold tracking-wide text-muted-foreground uppercase ${
              compact ? "px-1 py-1.5 text-[10px]" : "px-2 py-2.5 text-xs"
            }`}
          >
            Shift
          </div>
          {days.map((day) => (
            <div
              key={day}
              className={`flex items-center justify-center border-b border-l border-border bg-primary/5 font-semibold ${
                compact ? "px-1 py-1.5 text-[11px]" : "px-2 py-2.5 text-sm"
              }`}
            >
              {compact ? DAY_LABELS[day].slice(0, 3) : DAY_LABELS[day]}
            </div>
          ))}

          {rows.map((row) => (
            <div key={row.id} className="contents">
              <div
                className={`flex flex-col items-center justify-center gap-0.5 border-b border-border text-center ${
                  compact ? "px-1 py-1.5" : "px-2 py-3"
                } ${row.crossPeriod ? "bg-violet-500/5" : ""}`}
              >
                <p className={`font-semibold text-foreground ${compact ? "text-[10px]" : "text-sm"}`}>{row.name}</p>
                {!compact && (
                  <p className="text-[10px] text-muted-foreground">
                    {row.startTime}–{row.endTime}
                  </p>
                )}
                {row.crossPeriod && (
                  <p className={`text-violet-700 dark:text-violet-400 ${compact ? "text-[8px]" : "text-[10px]"}`}>cross-period</p>
                )}
              </div>
              {days.map((day) => (
                <GridCell
                  key={day}
                  row={row}
                  day={day}
                  scale={scale}
                  interactive={interactive}
                  roomOptions={roomOptions}
                  errorFlash={errorCell?.rowId === row.id && errorCell.day === day}
                  restrictedCellBlocked={
                    // A cross-period row is a deliberate, opt-in manual
                    // exception (only shown via the "Show cross-period
                    // shifts" toggle). The lecturer's availability shift
                    // list is built from their own-period shifts, so it
                    // never contains a cross-period one — applying this
                    // check there would block every cross-period drop and
                    // silently defeat the override. Own-period rows still
                    // honour the (day, shift) availability block in full.
                    !row.crossPeriod &&
                    activeLecturerAvailability !== null &&
                    !isShiftAllowedForLecturerOnDay(day, row.id, activeLecturerAvailability)
                  }
                  onEditSessionTime={onEditSessionTime}
                  onEditSessionRoom={onEditSessionRoom}
                  onUnscheduleSession={onUnscheduleSession}
                  onEditSession={onEditSession}
                  onDeleteSession={onDeleteSession}
                  onSetCrossPeriodOverride={onSetCrossPeriodOverride}
                  crossPeriodShiftOptions={crossPeriodRows}
                  sessions={sessions.filter((s) => s.dayOfWeek === day && rowForSession(s, rows)?.id === row.id)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      </div>
    </div>
  );

  if (!interactive) return grid;

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      {chips ? (
        compact ? (
          // Compact + interactive (the auto-generate overview's mini
          // cards): the tray is a small wrapped row of pills ABOVE the
          // grid, not a side-by-side sidebar — there simply isn't 256px
          // of spare width in a 3-5-column card grid. No trash-drop-zone
          // either: at this scale, dragging accurately onto a small
          // dedicated trash target is a real accuracy hazard, so
          // "delete" is instead each placed pill's own small tap target
          // (see PlacedCard's compact rendering above) — drag is still
          // fully available for moving a session or placing a chip.
          <div className="flex flex-col gap-2">
            {chips.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {chips.map((chip) => (
                  <DraggableChip key={chip.id} chip={chip} compact />
                ))}
              </div>
            )}
            {grid}
          </div>
        ) : (
          <div className="flex flex-col gap-4 lg:flex-row">
            <div className="flex w-full flex-col gap-2 lg:w-64 lg:shrink-0">
              <p className="text-sm font-semibold">Courses</p>
              <div className="flex flex-col gap-2">
                {chips.map((chip) => (
                  <DraggableChip key={chip.id} chip={chip} />
                ))}
                {chips.length === 0 && (
                  <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                    Nothing left unscheduled.
                  </p>
                )}
              </div>
              {onUnscheduleSession && <TrashDropZone />}
            </div>
            {grid}
          </div>
        )
      ) : (
        grid
      )}

      <DragOverlay>
        {activeDrag?.type === "chip" && (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-2.5 text-xs shadow-lg">
            <GripVertical className="size-3.5 shrink-0 text-muted-foreground" />
            <div>
              <p className="font-semibold text-foreground">{activeDrag.chip.courseName}</p>
              <p className="text-muted-foreground">{activeDrag.chip.lecturerName}</p>
            </div>
          </div>
        )}
        {activeDrag?.type === "session" && (
          <div className="rounded-lg border border-border border-l-4 border-l-primary bg-card p-2 text-xs shadow-lg">
            <p className="font-semibold text-foreground">{activeDrag.session.courseName}</p>
            <p className="text-muted-foreground">{activeDrag.session.lecturerName}</p>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
