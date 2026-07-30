"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
import {
  GripVertical,
  User,
  MapPin,
  Clock,
  Trash2,
  Loader2,
  CalendarClock,
  ArrowRight,
  Pencil,
} from "lucide-react";
import type { DayOfWeek } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { getActionErrorMessage } from "@/lib/action-error";
import { getValidDaysForStudyMode, DAY_LABELS } from "@/lib/timetable-days";
import { timeToMinutes } from "@/lib/timetable-conflicts";
import type { TimetablePanelData, SlotRow } from "./queries";
import {
  createTimetableSlot,
  updateTimetableSlot,
  deleteTimetableSlot,
  getClassScheduleSlots,
} from "./actions";

type ShiftOption = TimetablePanelData["shifts"][number];
type AssignmentOption = TimetablePanelData["assignments"][number];
type RoomOption = TimetablePanelData["rooms"][number];

// TimetableSlot has no Shift foreign key (a shift pick has always been a
// pure client-side time-fill convenience — see CLAUDE.md's Shifts
// section) — so a placed slot's grid ROW is resolved heuristically: the
// shift whose window contains the slot's own startTime, or if a custom
// time override has moved it outside every window, the shift with the
// closest start time. This is what lets a customized time stay visually
// anchored to the row it was dropped into instead of vanishing.
function shiftRowForSlot(slot: Pick<SlotRow, "startTime">, shiftsForClass: ShiftOption[]): ShiftOption | null {
  if (shiftsForClass.length === 0) return null;
  const t = timeToMinutes(slot.startTime);
  const contained = shiftsForClass.find(
    (s) => t >= timeToMinutes(s.startTime) && t < timeToMinutes(s.endTime)
  );
  if (contained) return contained;
  return [...shiftsForClass].sort(
    (a, b) => Math.abs(timeToMinutes(a.startTime) - t) - Math.abs(timeToMinutes(b.startTime) - t)
  )[0];
}

function cellId(shiftId: string, day: DayOfWeek) {
  return `cell:${shiftId}:${day}`;
}

const TRASH_ID = "trash-zone";

interface DraggableChipProps {
  assignment: AssignmentOption;
  scheduledCount: number;
}

function DraggableChip({ assignment, scheduledCount }: DraggableChipProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `chip:${assignment.id}`,
    data: { type: "chip" as const, assignmentId: assignment.id },
  });

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
        <p className="truncate font-semibold text-foreground">{assignment.course.name}</p>
        <p className="truncate text-muted-foreground">{assignment.lecturer.user.fullName}</p>
      </div>
      {scheduledCount > 0 && (
        <Badge variant="secondary" className="shrink-0 font-normal">
          {scheduledCount}x
        </Badge>
      )}
    </div>
  );
}

interface PlacedCardProps {
  slot: SlotRow;
  rooms: RoomOption[];
  mainRoomId: string;
  onUpdate: (patch: { roomId?: string; startTime?: string; endTime?: string }) => void;
  onUnschedule: () => void;
  busy: boolean;
}

function PlacedCard({ slot, rooms, mainRoomId, onUpdate, onUnschedule, busy }: PlacedCardProps) {
  const [editingTime, setEditingTime] = useState(false);
  const [editingRoom, setEditingRoom] = useState(false);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `slot:${slot.id}`,
    data: { type: "slot" as const, slotId: slot.id },
    disabled: busy || slot.id.startsWith("temp-"),
  });

  const hasRoomOverride = slot.roomId !== mainRoomId;

  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col gap-1.5 rounded-lg border border-border border-l-4 border-l-primary bg-card p-2 text-xs ${
        isDragging ? "opacity-40" : ""
      } ${busy ? "opacity-60" : ""}`}
      style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined}
    >
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          {...listeners}
          {...attributes}
          className="mt-0.5 shrink-0 cursor-grab touch-none text-muted-foreground active:cursor-grabbing"
          aria-label="Drag to move"
        >
          <GripVertical className="size-3.5" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-foreground">{slot.assignment.course.name}</p>
          <span className="flex items-center gap-1 text-muted-foreground">
            <User className="size-3 shrink-0" />
            <span className="truncate">{slot.assignment.lecturer.user.fullName}</span>
          </span>
        </div>
        {busy ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onUnschedule}
            className="shrink-0 text-muted-foreground hover:text-destructive"
            aria-label="Unschedule"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>

      {editingTime ? (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          className="flex items-center gap-1"
        >
          <Input
            type="time"
            defaultValue={slot.startTime}
            className="h-6 px-1 text-[11px]"
            onBlur={(e) => onUpdate({ startTime: e.target.value })}
          />
          <span className="text-muted-foreground">–</span>
          <Input
            type="time"
            defaultValue={slot.endTime}
            className="h-6 px-1 text-[11px]"
            onBlur={(e) => onUpdate({ endTime: e.target.value })}
          />
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setEditingTime(false)}
          >
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
          {slot.startTime}–{slot.endTime}
          <Pencil className="size-2.5 shrink-0" />
        </button>
      )}

      {editingRoom ? (
        <div onPointerDown={(e) => e.stopPropagation()} className="flex items-center gap-1">
          <SearchableSelect
            value={slot.roomId}
            onValueChange={(value) => {
              onUpdate({ roomId: value });
              setEditingRoom(false);
            }}
            items={rooms.map((r) => ({
              value: r.id,
              label: `${r.name} — ${r.campus.name}`,
              keywords: [r.campus.name],
            }))}
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
          <span className="truncate">
            {slot.room.name} — {slot.room.campus.name}
          </span>
          {hasRoomOverride && (
            <Badge variant="outline" className="ml-auto shrink-0 font-normal">
              override
            </Badge>
          )}
        </button>
      )}
    </div>
  );
}

interface GridCellProps {
  shift: ShiftOption;
  day: DayOfWeek;
  slots: SlotRow[];
  rooms: RoomOption[];
  mainRoomId: string;
  busySlotIds: Set<string>;
  errorFlash: boolean;
  onUpdateSlot: (slotId: string, patch: { roomId?: string; startTime?: string; endTime?: string }) => void;
  onUnscheduleSlot: (slotId: string) => void;
}

function GridCell({
  shift,
  day,
  slots,
  rooms,
  mainRoomId,
  busySlotIds,
  errorFlash,
  onUpdateSlot,
  onUnscheduleSlot,
}: GridCellProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: cellId(shift.id, day),
    data: { type: "cell" as const, shiftId: shift.id, day },
  });

  return (
    <div
      ref={setNodeRef}
      className={`flex min-h-20 flex-col gap-1.5 border-b border-l border-border p-1.5 transition-colors ${
        errorFlash
          ? "bg-destructive/15"
          : isOver
            ? "bg-primary/10"
            : ""
      }`}
    >
      {slots.map((slot) => (
        <PlacedCard
          key={slot.id}
          slot={slot}
          rooms={rooms}
          mainRoomId={mainRoomId}
          busy={busySlotIds.has(slot.id)}
          onUpdate={(patch) => onUpdateSlot(slot.id, patch)}
          onUnschedule={() => onUnscheduleSlot(slot.id)}
        />
      ))}
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

export function BuildTimetableClient({
  classes,
  assignments,
  rooms,
  shifts,
  semesters,
  activeSemesterId,
  onGoToShifts,
}: Pick<
  TimetablePanelData,
  "classes" | "assignments" | "rooms" | "shifts" | "semesters" | "activeSemesterId"
> & {
  onGoToShifts?: () => void;
}) {
  const router = useRouter();
  const [classId, setClassId] = useState("");
  const [semesterId, setSemesterId] = useState(activeSemesterId);
  const [mainRoomId, setMainRoomId] = useState("");
  const [placedSlots, setPlacedSlots] = useState<SlotRow[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [busySlotIds, setBusySlotIds] = useState<Set<string>>(new Set());
  const [activeDrag, setActiveDrag] = useState<
    { type: "chip"; assignment: AssignmentOption } | { type: "slot"; slot: SlotRow } | null
  >(null);
  const [errorCell, setErrorCell] = useState<{ shiftId: string; day: DayOfWeek } | null>(null);
  const requestIdRef = useRef(0);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // BOTH grid axes strictly derive from this ONE value —
  // selectedClass.studyMode — and nothing else. Neither `validDays` nor
  // `shiftsForClass` has a "show everything" fallback when it's null
  // (unlike some other studyMode-gated features in this app): a class
  // with no studyMode set blocks the grid entirely (see the amber warning
  // below) rather than silently mixing FT and PT days/shifts together.
  const selectedClass = classes.find((c) => c.id === classId) ?? null;
  const selectedStudyMode = selectedClass?.studyMode ?? null;
  const validDays = selectedStudyMode ? getValidDaysForStudyMode(selectedStudyMode)! : [];
  const shiftsForClass = selectedStudyMode
    ? shifts.filter((s) => s.studyMode === selectedStudyMode).sort((a, b) => a.startTime.localeCompare(b.startTime))
    : [];

  const assignmentOptionsForClass = useMemo(
    () => assignments.filter((a) => a.classId === classId && a.semesterId === semesterId),
    [assignments, classId, semesterId]
  );

  // Independent fetch, decoupled from the "Now" view's own URL-driven
  // Class/Lecturer/Room/Campus filters — this builder has its own local
  // class/semester selection, so it can't just reuse TimetablePanelData's
  // `slots` (which may be scoped to a completely different filter combo).
  useEffect(() => {
    // No class/semester picked yet — the callers that clear classId/
    // semesterId (resetBuilder, the semester picker's onValueChange)
    // already clear placedSlots directly, so there's nothing to
    // synchronize here.
    if (!classId || !semesterId) return;
    const requestId = ++requestIdRef.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingSlots(true);
    getClassScheduleSlots(classId, semesterId)
      .then((slots) => {
        if (requestIdRef.current === requestId) setPlacedSlots(slots);
      })
      .catch((error) => {
        if (requestIdRef.current === requestId) {
          toast.error(getActionErrorMessage(error, "Could not load this class's existing schedule."));
        }
      })
      .finally(() => {
        if (requestIdRef.current === requestId) setLoadingSlots(false);
      });
  }, [classId, semesterId]);

  function resetBuilder(nextClassId: string) {
    setClassId(nextClassId);
    setMainRoomId("");
    setPlacedSlots([]);
  }

  function flashError(shiftId: string, day: DayOfWeek) {
    setErrorCell({ shiftId, day });
    setTimeout(() => setErrorCell(null), 1200);
  }

  function markBusy(slotId: string, busy: boolean) {
    setBusySlotIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(slotId);
      else next.delete(slotId);
      return next;
    });
  }

  async function scheduleAssignment(assignmentId: string, day: DayOfWeek, shift: ShiftOption) {
    if (!mainRoomId) {
      toast.error("Select this class's room first.");
      return;
    }
    const assignment = assignments.find((a) => a.id === assignmentId);
    const room = rooms.find((r) => r.id === mainRoomId);
    if (!assignment || !room) return;

    const tempId = `temp-${crypto.randomUUID()}`;
    const optimistic = {
      id: tempId,
      lecturerCourseAssignmentId: assignmentId,
      dayOfWeek: day,
      startTime: shift.startTime,
      endTime: shift.endTime,
      roomId: mainRoomId,
      createdAt: new Date(),
      updatedAt: new Date(),
      assignment,
      room,
    } as SlotRow;

    setPlacedSlots((prev) => [...prev, optimistic]);
    markBusy(tempId, true);
    try {
      const created = await createTimetableSlot({
        lecturerCourseAssignmentId: assignmentId,
        dayOfWeek: day,
        startTime: shift.startTime,
        endTime: shift.endTime,
        roomId: mainRoomId,
      });
      setPlacedSlots((prev) => prev.map((s) => (s.id === tempId ? { ...s, id: created.id } : s)));
      router.refresh();
    } catch (error) {
      setPlacedSlots((prev) => prev.filter((s) => s.id !== tempId));
      flashError(shift.id, day);
      toast.error(getActionErrorMessage(error, "Could not schedule this session."));
    } finally {
      markBusy(tempId, false);
    }
  }

  async function moveSlot(slotId: string, day: DayOfWeek, shift: ShiftOption) {
    const before = placedSlots.find((s) => s.id === slotId);
    if (!before) return;

    setPlacedSlots((prev) =>
      prev.map((s) => (s.id === slotId ? { ...s, dayOfWeek: day, startTime: shift.startTime, endTime: shift.endTime } : s))
    );
    markBusy(slotId, true);
    try {
      await updateTimetableSlot(slotId, {
        lecturerCourseAssignmentId: before.lecturerCourseAssignmentId,
        dayOfWeek: day,
        startTime: shift.startTime,
        endTime: shift.endTime,
        roomId: before.roomId,
      });
      router.refresh();
    } catch (error) {
      setPlacedSlots((prev) => prev.map((s) => (s.id === slotId ? before : s)));
      flashError(shift.id, day);
      toast.error(getActionErrorMessage(error, "Could not move this session."));
    } finally {
      markBusy(slotId, false);
    }
  }

  async function updateSlot(slotId: string, patch: { roomId?: string; startTime?: string; endTime?: string }) {
    const before = placedSlots.find((s) => s.id === slotId);
    if (!before) return;
    const nextRoomId = patch.roomId ?? before.roomId;
    const nextStart = patch.startTime ?? before.startTime;
    const nextEnd = patch.endTime ?? before.endTime;
    if (nextStart === before.startTime && nextEnd === before.endTime && nextRoomId === before.roomId) return;
    const nextRoom = patch.roomId ? rooms.find((r) => r.id === patch.roomId) : before.room;
    if (!nextRoom) return;

    setPlacedSlots((prev) =>
      prev.map((s) =>
        s.id === slotId
          ? { ...s, roomId: nextRoomId, startTime: nextStart, endTime: nextEnd, room: nextRoom }
          : s
      )
    );
    markBusy(slotId, true);
    try {
      await updateTimetableSlot(slotId, {
        lecturerCourseAssignmentId: before.lecturerCourseAssignmentId,
        dayOfWeek: before.dayOfWeek,
        startTime: nextStart,
        endTime: nextEnd,
        roomId: nextRoomId,
      });
      router.refresh();
    } catch (error) {
      setPlacedSlots((prev) => prev.map((s) => (s.id === slotId ? before : s)));
      toast.error(getActionErrorMessage(error, "Could not update this session."));
    } finally {
      markBusy(slotId, false);
    }
  }

  async function unscheduleSlot(slotId: string) {
    const before = placedSlots;
    setPlacedSlots((prev) => prev.filter((s) => s.id !== slotId));
    markBusy(slotId, true);
    try {
      await deleteTimetableSlot(slotId);
      router.refresh();
    } catch (error) {
      setPlacedSlots(before);
      toast.error(getActionErrorMessage(error, "Could not unschedule this session."));
    } finally {
      markBusy(slotId, false);
    }
  }

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current;
    if (data?.type === "chip") {
      const assignment = assignments.find((a) => a.id === data.assignmentId);
      if (assignment) setActiveDrag({ type: "chip", assignment });
    } else if (data?.type === "slot") {
      const slot = placedSlots.find((s) => s.id === data.slotId);
      if (slot) setActiveDrag({ type: "slot", slot });
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
      if (activeData.type === "slot") unscheduleSlot(activeData.slotId);
      return;
    }

    if (overData.type === "cell") {
      const shift = shiftsForClass.find((s) => s.id === overData.shiftId);
      if (!shift) return;
      if (activeData.type === "chip") {
        scheduleAssignment(activeData.assignmentId, overData.day, shift);
      } else if (activeData.type === "slot") {
        moveSlot(activeData.slotId, overData.day, shift);
      }
    }
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Pick a class — its study mode determines the grid&rsquo;s valid days and which Shifts
          appear as rows. Drag a course chip onto a cell to schedule it; drag a placed session to
          move it, or drop it on the trash zone below to unschedule it.
        </p>

        <div className="flex flex-wrap gap-2">
          <div className="w-56">
            <SearchableSelect
              value={classId}
              onValueChange={resetBuilder}
              items={classes.map((c) => ({ value: c.id, label: c.name }))}
              placeholder="Select a class"
              searchPlaceholder="Search classes…"
              className="w-full"
            />
          </div>
          <div className="w-64">
            <SearchableSelect
              value={semesterId}
              onValueChange={(value) => {
                setSemesterId(value);
                setPlacedSlots([]);
              }}
              items={semesters.map((s) => ({
                value: s.id,
                label: `${s.name} (${s.academicYear.name})${s.isActive ? " — active" : ""}`,
              }))}
              placeholder="Select a semester"
              searchPlaceholder="Search semesters…"
              className="w-full"
            />
          </div>
          <div className="w-64">
            <SearchableSelect
              value={mainRoomId}
              onValueChange={setMainRoomId}
              items={rooms.map((r) => ({
                value: r.id,
                label: `${r.name} — ${r.campus.name}`,
                keywords: [r.campus.name],
              }))}
              placeholder={selectedClass ? "Select this class's room" : "Select a class first"}
              searchPlaceholder="Search rooms or campuses…"
              disabled={!selectedClass}
              className="w-full"
            />
          </div>
        </div>
        {/* Read-only confirmation, not a separate choice — studyMode is
            already a fixed property of the class (set at class creation
            under Academic Structure). Displaying it explicitly here, right
            after picking a class and before the grid renders, makes it
            impossible to mistake which mode is driving the day columns and
            Shift rows below; `selectedClass.studyMode` is the ONLY value
            either axis is ever derived from (see `validDays` and
            `shiftsForClass` below — both read it directly, nothing else). */}
        {selectedClass?.studyMode && (
          <p className="flex items-center gap-1.5 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs font-medium text-foreground">
            <CalendarClock className="size-3.5 shrink-0 text-primary" />
            This class is {selectedClass.studyMode === "FT" ? "Fulltime (FT)" : "Parttime (PT)"} —
            only {selectedClass.studyMode} shifts and days are shown below.
          </p>
        )}

        {selectedClass && (
          <p className="text-xs text-muted-foreground">
            This room is used for every new session dropped below by default — a class normally
            keeps one room for its whole week. Click a placed session&rsquo;s room to override it
            for that one exception (e.g. a lab).
          </p>
        )}

        {!selectedClass && (
          <p className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
            Pick a class to start building its week.
          </p>
        )}

        {selectedClass && !selectedClass.studyMode && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
            This class has no study mode set, so the drag-and-drop grid can&rsquo;t determine its
            valid days or Shifts. Set its study mode (FT/PT) under Academic Structure first.
          </p>
        )}

        {selectedClass?.studyMode && assignmentOptionsForClass.length === 0 && (
          <p className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
            This class has no course assignments for the selected semester yet — nothing to
            schedule. Assign courses to it first.
          </p>
        )}

        {selectedClass?.studyMode && assignmentOptionsForClass.length > 0 && shiftsForClass.length === 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border bg-muted/20 p-3 text-sm text-muted-foreground">
            <CalendarClock className="size-4 shrink-0" />
            <span>
              No Shift templates exist for {selectedClass.studyMode} yet — the grid needs at least
              one to have rows to drop sessions into.
            </span>
            {onGoToShifts && (
              <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={onGoToShifts}>
                Go to Shifts <ArrowRight className="size-3.5" />
              </Button>
            )}
          </div>
        )}

        {selectedClass?.studyMode &&
          assignmentOptionsForClass.length > 0 &&
          shiftsForClass.length > 0 &&
          !mainRoomId && (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
              Select a room above — every session dropped below will use it automatically.
            </p>
          )}

        {selectedClass?.studyMode && assignmentOptionsForClass.length > 0 && shiftsForClass.length > 0 && (
          <div className="flex flex-col gap-4 lg:flex-row">
            <div className="flex w-full flex-col gap-2 lg:w-64 lg:shrink-0">
              <p className="text-sm font-semibold">Courses</p>
              <div className="flex flex-col gap-2">
                {assignmentOptionsForClass.map((a) => (
                  <DraggableChip
                    key={a.id}
                    assignment={a}
                    scheduledCount={placedSlots.filter((s) => s.lecturerCourseAssignmentId === a.id).length}
                  />
                ))}
              </div>
              <TrashDropZone />
            </div>

            <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-card">
              <div className="overflow-x-auto">
                <div
                  className="grid"
                  style={{
                    gridTemplateColumns: `140px repeat(${validDays.length}, minmax(150px, 1fr))`,
                    minWidth: `${140 + validDays.length * 150}px`,
                  }}
                >
                  <div className="flex items-center justify-center border-b border-border bg-primary/5 px-2 py-2.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Shift
                  </div>
                  {validDays.map((day) => (
                    <div
                      key={day}
                      className="flex items-center justify-center border-b border-l border-border bg-primary/5 px-2 py-2.5 text-sm font-semibold"
                    >
                      {DAY_LABELS[day]}
                    </div>
                  ))}

                  {shiftsForClass.map((shift) => (
                    <div key={shift.id} className="contents">
                      <div className="flex flex-col items-center justify-center gap-0.5 border-b border-border px-2 py-3 text-center">
                        <p className="text-sm font-semibold text-foreground">{shift.name}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {shift.startTime}–{shift.endTime}
                        </p>
                      </div>
                      {validDays.map((day) => (
                        <GridCell
                          key={day}
                          shift={shift}
                          day={day}
                          rooms={rooms}
                          mainRoomId={mainRoomId}
                          busySlotIds={busySlotIds}
                          errorFlash={errorCell?.shiftId === shift.id && errorCell.day === day}
                          onUpdateSlot={updateSlot}
                          onUnscheduleSlot={unscheduleSlot}
                          slots={placedSlots.filter(
                            (s) => s.dayOfWeek === day && shiftRowForSlot(s, shiftsForClass)?.id === shift.id
                          )}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
              {loadingSlots && (
                <div className="flex items-center justify-center gap-2 border-t border-border p-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  Loading this class&rsquo;s existing schedule…
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <DragOverlay>
        {activeDrag?.type === "chip" && (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-2.5 text-xs shadow-lg">
            <GripVertical className="size-3.5 shrink-0 text-muted-foreground" />
            <div>
              <p className="font-semibold text-foreground">{activeDrag.assignment.course.name}</p>
              <p className="text-muted-foreground">{activeDrag.assignment.lecturer.user.fullName}</p>
            </div>
          </div>
        )}
        {activeDrag?.type === "slot" && (
          <div className="rounded-lg border border-border border-l-4 border-l-primary bg-card p-2 text-xs shadow-lg">
            <p className="font-semibold text-foreground">{activeDrag.slot.assignment.course.name}</p>
            <p className="text-muted-foreground">{activeDrag.slot.assignment.lecturer.user.fullName}</p>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
