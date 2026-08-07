"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, FileSpreadsheet, FileText } from "lucide-react";
import type { DayOfWeek, StudyMode, Period } from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  ScheduleGridRow,
  ScheduleGridSession,
  ScheduleGridChip,
  ScheduleGridRoomOption,
} from "@/components/timetable/schedule-grid";
import type { TimetableConflict } from "@/lib/timetable-conflicts";
import { getValidDaysForStudyMode, ALL_DAYS_ORDER } from "@/lib/timetable-days";
import {
  buildPreviewStateByClass,
  otherClassesAsConflictCandidates,
  classPreviewCounts,
  flattenSessionsForCommit,
  scheduleChipInClass,
  moveSessionInClass,
  unscheduleSessionInClass,
  editSessionTimeInClass,
  editSessionRoomInClass,
  setCrossPeriodOverrideInClass,
  type ClassPreviewState,
  type PreviewSession,
  type PreviewChip,
  type PreviewAssignmentMeta,
  type CommitSession,
} from "@/lib/auto-timetable-preview-state";
import type { GeneratorShiftOption } from "../workload-import/generator-data";
import type { PreviewBatchResult } from "./actions";
import { ClassMiniCard } from "./class-mini-card";
import { ClassFullscreenModal } from "./class-fullscreen-modal";
import { downloadPreviewExcel, downloadPreviewPdf, type ExportClassGrid, type PreviewExportData } from "./preview-export";
import { getActionErrorMessage } from "@/lib/action-error";

export interface OverviewClassMeta {
  className: string;
  studyMode: StudyMode | null;
  period: Period | null;
}

function rowsAndDaysForClass(
  meta: OverviewClassMeta | undefined,
  shifts: GeneratorShiftOption[]
): { rows: ScheduleGridRow[]; days: DayOfWeek[] } {
  const studyMode = meta?.studyMode ?? null;
  if (!studyMode) return { rows: [], days: ALL_DAYS_ORDER };
  const days = getValidDaysForStudyMode(studyMode) ?? ALL_DAYS_ORDER;
  const rows = shifts
    .filter((s) => s.studyMode === studyMode && (studyMode !== "FT" || s.period === meta?.period))
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
    .map((s) => ({ id: s.id, name: s.name, startTime: s.startTime, endTime: s.endTime }));
  return { rows, days };
}

// Manual, per-session, opt-in exception ONLY (see CLAUDE.md's "Period"
// business rule's "cross-period override" bullet) — the OTHER period's
// FT shifts, offered as extra rows (behind ScheduleGrid's own "Show
// cross-period shifts" toggle) in both the mini card and the fullscreen
// modal. Empty for PT or an FT class with no period set.
function crossPeriodRowsForClass(meta: OverviewClassMeta | undefined, shifts: GeneratorShiftOption[]): ScheduleGridRow[] {
  if (meta?.studyMode !== "FT" || !meta.period) return [];
  return shifts
    .filter((s) => s.studyMode === "FT" && s.period && s.period !== meta.period)
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
    .map((s) => ({ id: s.id, name: s.name, startTime: s.startTime, endTime: s.endTime, crossPeriod: true }));
}

function toGridSessions(sessions: PreviewSession[]): ScheduleGridSession[] {
  return sessions.map((s) => ({
    id: s.id,
    assignmentId: s.assignmentId,
    courseName: s.courseName,
    lecturerName: s.lecturerName,
    roomLabel: s.roomLabel,
    dayOfWeek: s.dayOfWeek,
    startTime: s.startTime,
    endTime: s.endTime,
    flagged: s.flagged,
    flagNote: s.flagged ? "Placed via spacing fallback — review recommended." : undefined,
    crossPeriodOverride: s.crossPeriodOverride,
  }));
}

function toGridChips(chips: PreviewChip[]): ScheduleGridChip[] {
  return chips.map((c) => ({
    id: c.id,
    assignmentId: c.assignmentId,
    courseName: c.courseName,
    lecturerName: c.lecturerName,
    badge: c.sessionCount > 1 ? `Session ${c.sessionNumber} of ${c.sessionCount}` : undefined,
  }));
}

function conflictMessage(conflicts: TimetableConflict[] | undefined): string {
  return conflicts && conflicts.length > 0 ? conflicts[0].message : "That slot conflicts with an existing booking.";
}

interface Props {
  preview: PreviewBatchResult;
  classMetaById: Map<string, OverviewClassMeta>;
  assignmentMetaById: Map<string, PreviewAssignmentMeta>;
  shifts: GeneratorShiftOption[];
  roomOptions: ScheduleGridRoomOption[];
  onBuildAll: (sessions: CommitSession[]) => void | Promise<void>;
  building: boolean;
  // The "Full width" toggle (auto-timetable-generator-client.tsx, next to
  // the semester filter) — expands this overview's own container to the
  // full page width and re-flows the card grid to more columns, in place.
  // Independent of, and never affects, an individual class's own
  // fullscreen review below (ClassFullscreenModal always renders at
  // fixed inset-0 full-viewport scale regardless of this prop).
  fullWidth?: boolean;
  // Only used to label the PDF/Excel preview export (admin/auto-timetable/
  // preview-export.ts) — this component has no other use for them.
  semesterLabel: string;
  level: number;
}

// Shows EVERY class in the currently-selected semester-level batch at
// once, as a responsive grid of mini schedule cards — each one FULLY
// drag-and-drop interactive at card scale (see CLAUDE.md's "Workload
// Excel import + auto-timetable generation" business rule and the
// "mini-grid is now fully interactive" changelog entry for the full
// design). Owns the editable local preview state for the whole batch —
// `stateByClass` — and every handler that mutates it, shared identically
// between each mini card and whichever class's fullscreen modal happens
// to be open; nothing is written to the DB until the caller's onBuildAll
// actually commits it.
export function MultiClassOverview({
  preview,
  classMetaById,
  assignmentMetaById,
  shifts,
  roomOptions,
  onBuildAll,
  building,
  fullWidth = false,
  semesterLabel,
  level,
}: Props) {
  const [stateByClass, setStateByClass] = useState<Map<string, ClassPreviewState>>(() =>
    buildPreviewStateByClass(preview)
  );
  const [expandedClassId, setExpandedClassId] = useState<string | null>(null);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  // Per-class error flash — a rejected drop in one card must never flash a
  // cell in another card, so this is keyed by classId rather than being a
  // single shared value.
  const [errorCellByClass, setErrorCellByClass] = useState<Map<string, { rowId: string; day: DayOfWeek }>>(
    new Map()
  );

  const classes = useMemo(
    () => [...stateByClass.values()].sort((a, b) => a.className.localeCompare(b.className)),
    [stateByClass]
  );

  const totals = useMemo(() => {
    return classes.reduce(
      (sum, cls) => {
        const c = classPreviewCounts(cls);
        return { scheduled: sum.scheduled + c.scheduled, flagged: sum.flagged + c.flagged, unscheduled: sum.unscheduled + c.unscheduled };
      },
      { scheduled: 0, flagged: 0, unscheduled: 0 }
    );
  }, [classes]);

  function flashError(classId: string, rowId: string, day: DayOfWeek, message: string) {
    setErrorCellByClass((prev) => new Map(prev).set(classId, { rowId, day }));
    toast.error(message);
    setTimeout(() => {
      setErrorCellByClass((prev) => {
        const next = new Map(prev);
        next.delete(classId);
        return next;
      });
    }, 1200);
  }

  // Every handler below is shared, unmodified, between a mini card and
  // the fullscreen modal — both read the SAME `stateByClass` and go
  // through the SAME pure lib/auto-timetable-preview-state.ts functions,
  // so "Build all" commits an identical result regardless of which view
  // (or a mix of both) an edit was made in.

  function handleScheduleChip(classId: string, chipId: string, day: DayOfWeek, row: ScheduleGridRow) {
    const cls = stateByClass.get(classId);
    const chip = cls?.chips.find((c) => c.id === chipId);
    const meta = chip ? assignmentMetaById.get(chip.assignmentId) : undefined;
    if (!cls || !chip || !meta) return;
    const external = otherClassesAsConflictCandidates(stateByClass, classId);
    const result = scheduleChipInClass(cls, chipId, day, row, meta, external);
    if (!result.ok) {
      flashError(classId, row.id, day, conflictMessage(result.conflicts));
      return;
    }
    setStateByClass(new Map(stateByClass).set(classId, result.cls));
  }

  function handleMoveSession(classId: string, sessionId: string, day: DayOfWeek, row: ScheduleGridRow) {
    const cls = stateByClass.get(classId);
    if (!cls) return;
    const external = otherClassesAsConflictCandidates(stateByClass, classId);
    const result = moveSessionInClass(cls, sessionId, day, row, external);
    if (!result.ok) {
      flashError(classId, row.id, day, conflictMessage(result.conflicts));
      return;
    }
    setStateByClass(new Map(stateByClass).set(classId, result.cls));
  }

  function handleUnscheduleSession(classId: string, sessionId: string) {
    const cls = stateByClass.get(classId);
    if (!cls) return;
    setStateByClass(new Map(stateByClass).set(classId, unscheduleSessionInClass(cls, sessionId)));
  }

  function handleEditSessionTime(classId: string, sessionId: string, patch: { startTime?: string; endTime?: string }) {
    const cls = stateByClass.get(classId);
    if (!cls) return;
    const external = otherClassesAsConflictCandidates(stateByClass, classId);
    const result = editSessionTimeInClass(cls, sessionId, patch, external);
    if (!result.ok) {
      toast.error(conflictMessage(result.conflicts));
      return;
    }
    setStateByClass(new Map(stateByClass).set(classId, result.cls));
  }

  function handleEditSessionRoom(classId: string, sessionId: string, roomId: string) {
    const cls = stateByClass.get(classId);
    const room = roomOptions.find((r) => r.value === roomId);
    if (!cls || !room) return;
    const external = otherClassesAsConflictCandidates(stateByClass, classId);
    const result = editSessionRoomInClass(cls, sessionId, roomId, room.label, external);
    if (!result.ok) {
      toast.error(conflictMessage(result.conflicts));
      return;
    }
    setStateByClass(new Map(stateByClass).set(classId, result.cls));
  }

  // Plain flag flip — no conflict check needed (day/time/room are
  // untouched), always succeeds. Used by the fullscreen modal's inline
  // checkbox (see PlacedCard's cross-period block); the mini card doesn't
  // get inline editing at all (compact scale), so it never calls this —
  // its only cross-period path is dragging directly onto a cross-period
  // row, which handleScheduleChip/handleMoveSession already derive from
  // row.crossPeriod automatically.
  function handleSetCrossPeriodOverride(classId: string, sessionId: string, allow: boolean) {
    const cls = stateByClass.get(classId);
    if (!cls) return;
    const result = setCrossPeriodOverrideInClass(cls, sessionId, allow);
    if (result.ok) setStateByClass(new Map(stateByClass).set(classId, result.cls));
  }

  // The current preview state — including any manual drag/edit adjustments
  // already made in the overview or a class's fullscreen review — reshaped
  // into the plain data admin/auto-timetable/preview-export.ts's PDF/Excel
  // builders need. Deliberately NOT the raw un-edited algorithm output:
  // this reads `stateByClass` (the live, possibly-edited state), the exact
  // same source every mini card and the fullscreen modal already render
  // from, so the export can never disagree with what's currently on screen.
  function buildExportData(): PreviewExportData {
    const classes: ExportClassGrid[] = [...stateByClass.values()]
      .sort((a, b) => a.className.localeCompare(b.className))
      .map((cls) => {
        const meta = classMetaById.get(cls.classId);
        const { rows, days } = rowsAndDaysForClass(meta, shifts);
        return {
          classId: cls.classId,
          className: cls.className,
          rows,
          days,
          sessions: cls.sessions.map((s) => ({
            id: s.id,
            courseName: s.courseName,
            lecturerName: s.lecturerName,
            roomLabel: s.roomLabel,
            dayOfWeek: s.dayOfWeek,
            startTime: s.startTime,
            endTime: s.endTime,
            flagged: s.flagged,
            crossPeriodOverride: s.crossPeriodOverride,
          })),
        };
      });
    return { semesterLabel, level, classes };
  }

  async function handleExportExcel() {
    setExportingExcel(true);
    try {
      await downloadPreviewExcel(buildExportData());
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not export this preview to Excel."));
    } finally {
      setExportingExcel(false);
    }
  }

  async function handleExportPdf() {
    setExportingPdf(true);
    try {
      const { overflowClassNames } = await downloadPreviewPdf(buildExportData());
      // A class dense enough that even the smallest readable font size
      // couldn't fit its whole grid on one page still downloads (spilling
      // onto a further page, same as before this fix) — but it's now
      // reported explicitly rather than left for the admin to discover a
      // still-cut-off page on their own.
      if (overflowClassNames.length > 0) {
        toast.warning(
          `${overflowClassNames.length} class${overflowClassNames.length === 1 ? "" : "es"} couldn't fit on one page even at the smallest readable font size: ${overflowClassNames.join(", ")}. That class's grid spans an extra page instead of being shrunk further.`
        );
      }
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not export this preview to PDF."));
    } finally {
      setExportingPdf(false);
    }
  }

  const expandedClass = expandedClassId ? stateByClass.get(expandedClassId) : null;
  const expandedMeta = expandedClassId ? classMetaById.get(expandedClassId) : undefined;
  const expandedGrid = useMemo(
    () => (expandedMeta ? rowsAndDaysForClass(expandedMeta, shifts) : { rows: [], days: [] as DayOfWeek[] }),
    [expandedMeta, shifts]
  );

  if (classes.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        Nothing was scheduled or flagged for this semester level.
      </p>
    );
  }

  return (
    // The "Full width" toggle's breakout: AppShell's <main> wraps every
    // admin page in p-4 sm:p-6 (see components/layout/app-shell.tsx) —
    // there's no separate max-width wrapper to fight in this app, the
    // sidebar's fixed 256px width is the only other constraint, and this
    // page doesn't own layout state to hide that. Negative margins exactly
    // matching that padding let this ONE section's card grid reach the
    // true available width (flush to the sidebar edge and the viewport's
    // right edge) without touching AppShell or any other section of this
    // screen — the semester filter/banners/assignments table above stay at
    // their normal width, matching "only affects the OVERVIEW grid."
    <div className={fullWidth ? "flex flex-col gap-3 -mx-4 sm:-mx-6" : "flex flex-col gap-3"}>
      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 p-3 ${fullWidth ? "mx-4 sm:mx-6" : ""}`}
      >
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <p className="font-semibold">
            {classes.length} class{classes.length === 1 ? "" : "es"} in this batch:
          </p>
          <Badge variant="published">Scheduled ({totals.scheduled})</Badge>
          {totals.flagged > 0 && <Badge variant="draft">Flagged ({totals.flagged})</Badge>}
          {totals.unscheduled > 0 && <Badge variant="destructive">Unscheduled ({totals.unscheduled})</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Exports the CURRENT preview state (including any manual
              adjustments already made) — see admin/auto-timetable/
              preview-export.ts's own doc comment for why this is built
              entirely client-side rather than through a Server Action.
              Available before "Build all" — this is a review/sharing aid
              for the still-unconfirmed batch, not a record of what was
              actually written. */}
          <Button type="button" variant="outline" onClick={handleExportExcel} disabled={exportingExcel}>
            {exportingExcel ? <Loader2 className="size-4 animate-spin" /> : <FileSpreadsheet className="size-4" />}
            Export Excel
          </Button>
          <Button type="button" variant="outline" onClick={handleExportPdf} disabled={exportingPdf}>
            {exportingPdf ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />}
            Export PDF
          </Button>
          <Button onClick={() => onBuildAll(flattenSessionsForCommit(stateByClass))} disabled={building || totals.scheduled === 0}>
            {building && <Loader2 className="size-4 animate-spin" />}
            Build all
          </Button>
        </div>
      </div>

      {/* Full width keeps the summary bar above visually inset (matching
          every other section on this page) but lets the card grid itself
          reach the true edges — that's the actual "more columns visible"
          gain; re-padding the grid the same as the summary bar would
          cancel the breakout out entirely. */}
      <div
        className={
          fullWidth
            ? "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
            : "grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3"
        }
      >
        {classes.map((cls) => {
          const meta = classMetaById.get(cls.classId);
          const { rows, days } = rowsAndDaysForClass(meta, shifts);
          return (
            <ClassMiniCard
              key={cls.classId}
              className={cls.className}
              rows={rows}
              days={days}
              sessions={toGridSessions(cls.sessions)}
              chips={toGridChips(cls.chips)}
              counts={classPreviewCounts(cls)}
              errorCell={errorCellByClass.get(cls.classId) ?? null}
              onExpand={() => setExpandedClassId(cls.classId)}
              onScheduleChip={(chipId, day, row) => handleScheduleChip(cls.classId, chipId, day, row)}
              onMoveSession={(sessionId, day, row) => handleMoveSession(cls.classId, sessionId, day, row)}
              onUnscheduleSession={(sessionId) => handleUnscheduleSession(cls.classId, sessionId)}
              crossPeriodRows={crossPeriodRowsForClass(meta, shifts)}
            />
          );
        })}
      </div>

      {expandedClass && expandedClassId && (
        <ClassFullscreenModal
          className={expandedClass.className}
          rows={expandedGrid.rows}
          days={expandedGrid.days}
          sessions={toGridSessions(expandedClass.sessions)}
          chips={toGridChips(expandedClass.chips)}
          counts={classPreviewCounts(expandedClass)}
          roomOptions={roomOptions}
          errorCell={errorCellByClass.get(expandedClassId) ?? null}
          onScheduleChip={(chipId, day, row) => handleScheduleChip(expandedClassId, chipId, day, row)}
          onMoveSession={(sessionId, day, row) => handleMoveSession(expandedClassId, sessionId, day, row)}
          onUnscheduleSession={(sessionId) => handleUnscheduleSession(expandedClassId, sessionId)}
          onEditSessionTime={(sessionId, patch) => handleEditSessionTime(expandedClassId, sessionId, patch)}
          onEditSessionRoom={(sessionId, roomId) => handleEditSessionRoom(expandedClassId, sessionId, roomId)}
          crossPeriodRows={crossPeriodRowsForClass(expandedMeta, shifts)}
          onSetCrossPeriodOverride={(sessionId, allow) => handleSetCrossPeriodOverride(expandedClassId, sessionId, allow)}
          onClose={() => setExpandedClassId(null)}
        />
      )}
    </div>
  );
}
