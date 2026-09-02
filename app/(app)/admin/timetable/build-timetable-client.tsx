"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2, CalendarClock, ArrowRight, MapPin, Trash2, AlertTriangle } from "lucide-react";
import type { DayOfWeek } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { getActionErrorMessage } from "@/lib/action-error";
import { getValidDaysForStudyMode, groupLecturerAvailabilityRows } from "@/lib/timetable-days";
import { formatClassLabel } from "@/lib/class-label";
import { ScheduleGrid, type ScheduleGridSession, type ScheduleGridChip, type ScheduleGridRow } from "@/components/timetable/schedule-grid";
import type { TimetablePanelData, SlotRow } from "./queries";
import {
  createTimetableSlot,
  updateTimetableSlot,
  deleteTimetableSlot,
  getClassScheduleSlots,
  clearClassTimetable,
} from "./actions";
import { SendClassTimetableNotificationsButton } from "./send-class-timetable-notifications-button";

type ShiftOption = TimetablePanelData["shifts"][number];

const PERIOD_LABELS: Record<"MORNING" | "AFTERNOON", string> = {
  MORNING: "Morning (Subax)",
  AFTERNOON: "Afternoon (Galab)",
};

function toGridRow(shift: ShiftOption): ScheduleGridRow {
  return { id: shift.id, name: shift.name, startTime: shift.startTime, endTime: shift.endTime };
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
  const [placedSlots, setPlacedSlots] = useState<SlotRow[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [busySlotIds, setBusySlotIds] = useState<Set<string>>(new Set());
  const [errorCell, setErrorCell] = useState<{ rowId: string; day: DayOfWeek } | null>(null);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const requestIdRef = useRef(0);

  // BOTH grid axes strictly derive from this ONE value —
  // selectedClass.studyMode — and nothing else. Neither `validDays` nor
  // `shiftsForClass` has a "show everything" fallback when it's null
  // (unlike some other studyMode-gated features in this app): a class
  // with no studyMode set blocks the grid entirely (see the amber warning
  // below) rather than silently mixing FT and PT days/shifts together.
  const selectedClass = classes.find((c) => c.id === classId) ?? null;
  const selectedStudyMode = selectedClass?.studyMode ?? null;
  const validDays = selectedStudyMode ? getValidDaysForStudyMode(selectedStudyMode)! : [];
  // Period (Morning/Afternoon) is a second, FT-only restriction on top of
  // studyMode — same rule the auto-generate algorithm enforces (see
  // lib/auto-timetable.ts and CLAUDE.md's "Period" business rule). A
  // Morning-period class's grid rows are ONLY Subax shifts, never Galab,
  // and vice versa; PT is completely unaffected (no period concept at
  // all, so nothing here narrows further for it). An FT class with no
  // period assigned yet blocks the grid entirely (see the amber warning
  // below) rather than showing every FT shift across both periods.
  const periodOk = selectedStudyMode !== "FT" || !!selectedClass?.period;
  const shiftsForClass = selectedStudyMode
    ? shifts
        .filter(
          (s) =>
            s.studyMode === selectedStudyMode &&
            (selectedStudyMode !== "FT" || s.period === selectedClass?.period)
        )
        .sort((a, b) => a.startTime.localeCompare(b.startTime))
    : [];
  const gridRows = shiftsForClass.map(toGridRow);
  // Manual, per-session, opt-in exception ONLY (see CLAUDE.md's "Period"
  // business rule's "cross-period override" bullet) — the OTHER period's
  // FT shifts, offered as extra rows behind ScheduleGrid's own "Show
  // cross-period shifts" toggle (default hidden) and as the inline
  // picker's option list. Empty for PT or an FT class with no period set
  // — there's no "other period" to offer either way.
  const crossPeriodShiftsForClass =
    selectedStudyMode === "FT" && selectedClass?.period
      ? shifts
          .filter((s) => s.studyMode === "FT" && s.period && s.period !== selectedClass.period)
          .sort((a, b) => a.startTime.localeCompare(b.startTime))
      : [];
  const crossPeriodGridRows: ScheduleGridRow[] = crossPeriodShiftsForClass.map((s) => ({
    ...toGridRow(s),
    crossPeriod: true,
  }));

  // Room is a CLASS-REGISTRATION property now (Class.roomId, set under
  // Academic Structure > Classes), never a per-build-session choice — the
  // builder just reads it. `classRoomId` is null both when no class is
  // selected AND when the selected class genuinely has no room assigned
  // yet; either way nothing can be scheduled until it's set elsewhere.
  const classRoomId = selectedClass?.roomId ?? null;
  const classRoom = selectedClass?.room ?? null;

  const assignmentOptionsForClass = useMemo(
    () => assignments.filter((a) => a.classId === classId && a.semesterId === semesterId),
    [assignments, classId, semesterId]
  );

  const roomOptions = useMemo(
    () => rooms.map((r) => ({ value: r.id, label: `${r.name} — ${r.campus.name}`, keywords: [r.campus.name] })),
    [rooms]
  );

  const gridSessions = useMemo<ScheduleGridSession[]>(
    () =>
      placedSlots.map((slot) => ({
        id: slot.id,
        assignmentId: slot.lecturerCourseAssignmentId,
        courseName: slot.assignment.course.name,
        lecturerName: slot.assignment.lecturer.fullName,
        lecturerAvailability: groupLecturerAvailabilityRows(slot.assignment.lecturer.availability),
        roomLabel: `${slot.room.name} — ${slot.room.campus.name}`,
        dayOfWeek: slot.dayOfWeek,
        startTime: slot.startTime,
        endTime: slot.endTime,
        busy: busySlotIds.has(slot.id),
        roomOverride: slot.roomId !== classRoomId,
        crossPeriodOverride: slot.crossPeriodOverride,
      })),
    [placedSlots, busySlotIds, classRoomId]
  );

  const gridChips = useMemo<ScheduleGridChip[]>(
    () =>
      assignmentOptionsForClass.map((a) => ({
        id: a.id,
        assignmentId: a.id,
        courseName: a.course.name,
        lecturerName: a.lecturer.fullName,
        lecturerAvailability: groupLecturerAvailabilityRows(a.lecturer.availability),
        badge: (() => {
          const count = placedSlots.filter((s) => s.lecturerCourseAssignmentId === a.id).length;
          return count > 0 ? `${count}x` : undefined;
        })(),
      })),
    [assignmentOptionsForClass, placedSlots]
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
    setPlacedSlots([]);
  }

  function flashError(rowId: string, day: DayOfWeek) {
    setErrorCell({ rowId, day });
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

  async function scheduleAssignment(assignmentId: string, day: DayOfWeek, row: ScheduleGridRow) {
    if (!classRoomId) {
      toast.error("This class has no room assigned — set one in Academic Structure > Classes first.");
      return;
    }
    const assignment = assignments.find((a) => a.id === assignmentId);
    const room = rooms.find((r) => r.id === classRoomId);
    if (!assignment || !room) return;

    const tempId = `temp-${crypto.randomUUID()}`;
    const crossPeriodOverride = !!row.crossPeriod;
    const optimistic = {
      id: tempId,
      lecturerCourseAssignmentId: assignmentId,
      dayOfWeek: day,
      startTime: row.startTime,
      endTime: row.endTime,
      roomId: classRoomId,
      crossPeriodOverride,
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
        startTime: row.startTime,
        endTime: row.endTime,
        roomId: classRoomId,
        crossPeriodOverride,
      });
      setPlacedSlots((prev) => prev.map((s) => (s.id === tempId ? { ...s, id: created.id } : s)));
      router.refresh();
    } catch (error) {
      setPlacedSlots((prev) => prev.filter((s) => s.id !== tempId));
      flashError(row.id, day);
      toast.error(getActionErrorMessage(error, "Could not schedule this session."));
    } finally {
      markBusy(tempId, false);
    }
  }

  async function moveSlot(slotId: string, day: DayOfWeek, row: ScheduleGridRow) {
    const before = placedSlots.find((s) => s.id === slotId);
    if (!before) return;
    // Derived fresh from the target row, same as auto-generate's own
    // preview state — moving a session ONTO a cross-period row marks it;
    // moving it back onto a normal (own-period) row clears the flag
    // again. The flag always reflects CURRENT placement.
    const crossPeriodOverride = !!row.crossPeriod;

    setPlacedSlots((prev) =>
      prev.map((s) =>
        s.id === slotId ? { ...s, dayOfWeek: day, startTime: row.startTime, endTime: row.endTime, crossPeriodOverride } : s
      )
    );
    markBusy(slotId, true);
    try {
      await updateTimetableSlot(slotId, {
        lecturerCourseAssignmentId: before.lecturerCourseAssignmentId,
        dayOfWeek: day,
        startTime: row.startTime,
        endTime: row.endTime,
        roomId: before.roomId,
        crossPeriodOverride,
      });
      router.refresh();
    } catch (error) {
      setPlacedSlots((prev) => prev.map((s) => (s.id === slotId ? before : s)));
      flashError(row.id, day);
      toast.error(getActionErrorMessage(error, "Could not move this session."));
    } finally {
      markBusy(slotId, false);
    }
  }

  async function updateSlot(
    slotId: string,
    patch: { roomId?: string; startTime?: string; endTime?: string; crossPeriodOverride?: boolean }
  ) {
    const before = placedSlots.find((s) => s.id === slotId);
    if (!before) return;
    const nextRoomId = patch.roomId ?? before.roomId;
    const nextStart = patch.startTime ?? before.startTime;
    const nextEnd = patch.endTime ?? before.endTime;
    // Omitted = preserve the slot's current flag unchanged (a plain time/
    // room edit never touches it) — provided = set it explicitly, which is
    // how both the checkbox toggle and the inline cross-period shift
    // picker apply it.
    const nextCrossPeriod = patch.crossPeriodOverride ?? before.crossPeriodOverride;
    if (
      nextStart === before.startTime &&
      nextEnd === before.endTime &&
      nextRoomId === before.roomId &&
      nextCrossPeriod === before.crossPeriodOverride
    ) {
      return;
    }
    const nextRoom = patch.roomId ? rooms.find((r) => r.id === patch.roomId) : before.room;
    if (!nextRoom) return;

    setPlacedSlots((prev) =>
      prev.map((s) =>
        s.id === slotId
          ? { ...s, roomId: nextRoomId, startTime: nextStart, endTime: nextEnd, room: nextRoom, crossPeriodOverride: nextCrossPeriod }
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
        crossPeriodOverride: nextCrossPeriod,
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

  async function handleClearTimetable() {
    if (!classId || !semesterId) return;
    setClearing(true);
    try {
      const result = await clearClassTimetable(classId, semesterId);
      setPlacedSlots([]);
      toast.success(
        `${result.deleted} session${result.deleted === 1 ? "" : "s"} removed from ${selectedClass ? formatClassLabel(selectedClass) : "this class"}.`
      );
      setConfirmClearOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not clear this class's timetable."));
    } finally {
      setClearing(false);
    }
  }

  return (
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
            items={classes.map((c) => ({ value: c.id, label: formatClassLabel(c) }))}
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
        {selectedClass && placedSlots.length > 0 && (
          <>
            <SendClassTimetableNotificationsButton classId={classId} semesterId={semesterId} />
            <Button
              type="button"
              variant="outline"
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmClearOpen(true)}
            >
              <Trash2 className="size-4" />
              Clear timetable
            </Button>
          </>
        )}
      </div>
      {/* Read-only confirmation, not a separate choice — studyMode is
          already a fixed property of the class (set at class creation
          under Academic Structure). Displaying it explicitly here, right
          after picking a class and before the grid renders, makes it
          impossible to mistake which mode is driving the day columns and
          Shift rows below; `selectedClass.studyMode` is the ONLY value
          either axis is ever derived from (see `validDays` and
          `shiftsForClass` above — both read it directly, nothing else). */}
      {selectedClass?.studyMode && (
        <p className="flex items-center gap-1.5 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs font-medium text-foreground">
          <CalendarClock className="size-3.5 shrink-0 text-primary" />
          This class is {selectedClass.studyMode === "FT" ? "Fulltime (FT)" : "Parttime (PT)"}
          {selectedClass.studyMode === "FT" && selectedClass.period
            ? ` — ${PERIOD_LABELS[selectedClass.period]}`
            : ""}{" "}
          — only {selectedClass.studyMode}
          {selectedClass.studyMode === "FT" && selectedClass.period
            ? ` ${selectedClass.period === "MORNING" ? "Subax" : "Galab"}`
            : ""}{" "}
          shifts and days are shown below.
        </p>
      )}

      {/* Room is a class-registration property (Class.roomId, set under
          Academic Structure > Classes) — the builder only ever READS it
          here, it never asks for one. */}
      {classRoom && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MapPin className="size-3.5 shrink-0" />
          Sessions use <span className="font-medium text-foreground">{classRoom.name} — {classRoom.campus.name}</span>{" "}
          automatically (this class&rsquo;s default room). Click a placed session&rsquo;s room to
          override it for that one exception (e.g. a lab).
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

      {selectedClass?.studyMode && !classRoomId && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          <MapPin className="size-4 shrink-0" />
          <span>
            This class has no room assigned — set one in Academic Structure &gt; Classes first.
          </span>
          <Link
            href={`/admin/structure?tab=classes&editClassId=${selectedClass.id}`}
            className="flex items-center gap-1 font-medium underline underline-offset-2"
          >
            Set this class&rsquo;s room <ArrowRight className="size-3.5" />
          </Link>
        </div>
      )}

      {selectedClass?.studyMode === "FT" && !selectedClass.period && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          <CalendarClock className="size-4 shrink-0" />
          <span>
            This class has no period (Morning/Afternoon) assigned — set one in Academic
            Structure &gt; Classes first.
          </span>
          <Link
            href={`/admin/structure?tab=classes&editClassId=${selectedClass.id}`}
            className="flex items-center gap-1 font-medium underline underline-offset-2"
          >
            Set this class&rsquo;s period <ArrowRight className="size-3.5" />
          </Link>
        </div>
      )}

      {selectedClass?.studyMode && classRoomId && periodOk && assignmentOptionsForClass.length === 0 && (
        <p className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
          This class has no course assignments for the selected semester yet — nothing to
          schedule. Assign courses to it first.
        </p>
      )}

      {selectedClass?.studyMode &&
        classRoomId &&
        periodOk &&
        assignmentOptionsForClass.length > 0 &&
        shiftsForClass.length === 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border bg-muted/20 p-3 text-sm text-muted-foreground">
            <CalendarClock className="size-4 shrink-0" />
            <span>
              No Shift templates exist for {selectedClass.studyMode}
              {selectedClass.studyMode === "FT" && selectedClass.period
                ? ` (${PERIOD_LABELS[selectedClass.period]})`
                : ""}{" "}
              yet — the grid needs at least one to have rows to drop sessions into.
            </span>
            {onGoToShifts && (
              <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={onGoToShifts}>
                Go to Shifts <ArrowRight className="size-3.5" />
              </Button>
            )}
          </div>
        )}

      {selectedClass?.studyMode &&
        classRoomId &&
        periodOk &&
        assignmentOptionsForClass.length > 0 &&
        shiftsForClass.length > 0 && (
          <>
            <ScheduleGrid
              rows={gridRows}
              days={validDays}
              sessions={gridSessions}
              chips={gridChips}
              roomOptions={roomOptions}
              errorCell={errorCell}
              onScheduleChip={(chipId, day, row) => scheduleAssignment(chipId, day, row)}
              onMoveSession={(sessionId, day, row) => moveSlot(sessionId, day, row)}
              onUnscheduleSession={unscheduleSlot}
              onEditSessionTime={(sessionId, patch) => updateSlot(sessionId, patch)}
              onEditSessionRoom={(sessionId, roomId) => updateSlot(sessionId, { roomId })}
              crossPeriodRows={crossPeriodGridRows}
              onSetCrossPeriodOverride={(sessionId, allow) => updateSlot(sessionId, { crossPeriodOverride: allow })}
            />
            {loadingSlots && (
              <div className="flex items-center justify-center gap-2 rounded-lg border border-border p-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Loading this class&rsquo;s existing schedule…
              </div>
            )}
          </>
        )}

      <Dialog open={confirmClearOpen} onOpenChange={(open) => !clearing && setConfirmClearOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear timetable for {selectedClass ? formatClassLabel(selectedClass) : "this class"}?</DialogTitle>
            <DialogDescription>
              This will delete {placedSlots.length} scheduled session{placedSlots.length === 1 ? "" : "s"} for{" "}
              {selectedClass ? formatClassLabel(selectedClass) : "this class"}. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p>
              Only the scheduled sessions are removed — course assignments and credit hours stay
              intact, so you can re-generate without re-uploading a workload Excel.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmClearOpen(false)} disabled={clearing}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={handleClearTimetable} disabled={clearing}>
              {clearing && <Loader2 className="size-4 animate-spin" />}
              Yes, clear this timetable
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
