"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  CalendarX2,
  CalendarClock,
  Download,
  Loader2,
  RotateCcw,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  ScheduleGrid,
  type ScheduleGridSession,
} from "@/components/timetable/schedule-grid";
import { getActionErrorMessage } from "@/lib/action-error";
import { downloadBase64 } from "@/lib/download";
import { useUrlTableState } from "@/lib/use-url-table-state";
import { DAY_LABELS, ALL_DAYS_ORDER } from "@/lib/timetable-days";
import { formatClassLabel } from "@/lib/class-label";
import { exportTimetable } from "./actions";
import { buildNowGrids } from "./now-grid";
import { ALL_SEMESTERS_VALUE } from "./constants";
import type { NowViewData } from "./panel";
import type { TimetablePanelData, SlotRow } from "./queries";

const ALL_VALUE = "";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type ShiftOption = TimetablePanelData["shifts"][number];

function ShiftButton({
  shift,
  selected,
  onClick,
}: {
  shift: ShiftOption;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={selected ? "default" : "ghost"}
      onClick={onClick}
      className="h-auto flex-col items-start gap-0 px-3 py-1.5"
    >
      <span>{shift.name}</span>
      <span className={selected ? "text-[10px] opacity-80" : "text-[10px] text-muted-foreground"}>
        {shift.startTime}–{shift.endTime}
      </span>
    </Button>
  );
}

export function NowViewClient({
  nowView,
  classes,
  lecturers,
  rooms,
  campuses,
  shifts,
  semesters,
  onEdit,
  onDelete,
  onGoToShifts,
}: {
  nowView: NowViewData;
  classes: TimetablePanelData["classes"];
  lecturers: TimetablePanelData["lecturers"];
  rooms: TimetablePanelData["rooms"];
  campuses: TimetablePanelData["campuses"];
  shifts: TimetablePanelData["shifts"];
  semesters: TimetablePanelData["semesters"];
  onEdit?: (slot: SlotRow) => void;
  onDelete?: (slot: SlotRow) => void;
  onGoToShifts?: () => void;
}) {
  const table = useUrlTableState();
  const [exporting, setExporting] = useState(false);

  const quick = nowView.quick;
  const dayFilterValue = table.getFilter("dayOfWeek");
  const classIdFilter = table.getFilter("classId");
  const campusIdFilter = table.getFilter("campusId");
  const semesterIdFilter = table.getFilter("semesterId");

  // Only offer shifts relevant to what's being viewed: a class filter
  // narrows the buttons to that class's own studyMode (a class with no
  // studyMode set yet has no restriction, same fallback this app already
  // uses everywhere else studyMode gates something — every shift is
  // offered). With no class filter, every active shift is offered,
  // grouped by studyMode so it's clear which is which.
  const selectedClass = classIdFilter ? classes.find((c) => c.id === classIdFilter) : undefined;
  const selectedStudyMode = selectedClass?.studyMode ?? null;
  const relevantShifts = selectedStudyMode
    ? shifts.filter((s) => s.studyMode === selectedStudyMode)
    : shifts;
  const ftShifts = relevantShifts.filter((s) => s.studyMode === "FT");
  const ptShifts = relevantShifts.filter((s) => s.studyMode === "PT");
  const showGrouped = !selectedStudyMode && ftShifts.length > 0 && ptShifts.length > 0;

  // A large university may have identically-named rooms across campuses —
  // narrowing the Room filter's own options to the selected Campus is the
  // same progressive-narrowing convention used everywhere else a
  // Room/Campus pair is picked in this app.
  const roomsForFilter = campusIdFilter ? rooms.filter((r) => r.campusId === campusIdFilter) : rooms;

  function resetFilters() {
    for (const key of ["classId", "lecturerId", "roomId", "campusId", "dayOfWeek"]) {
      table.setFilter(key, "");
    }
  }

  // Picking "Now" always means "live, today" — clear any explicit Day
  // filter in the SAME navigation (setFilters, not two setFilter calls;
  // see its own comment in use-url-table-state.ts for why two sequential
  // calls would silently drop one of the two updates).
  function selectNow() {
    table.setFilters({ quick: "now", dayOfWeek: "" });
  }

  // Picking a day always means "show that day's sessions" — if "Now" was
  // active, flip it to "full" atomically in the same navigation so the
  // result isn't fighting "now"'s live/today-only semantics (a Shift
  // selection is left as-is; it composes with whichever day ends up
  // selected, see resolveNowView).
  function selectDay(value: string | null) {
    const day = !value || value === ALL_VALUE ? "" : value;
    if (quick === "now") {
      table.setFilters({ dayOfWeek: day, quick: "full" });
    } else {
      table.setFilter("dayOfWeek", day);
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      const { base64, fileName } = await exportTimetable({
        quick,
        dayOfWeek: dayFilterValue ? (dayFilterValue as never) : undefined,
        classId: table.getFilter("classId") || undefined,
        lecturerId: table.getFilter("lecturerId") || undefined,
        roomId: table.getFilter("roomId") || undefined,
        campusId: table.getFilter("campusId") || undefined,
        semesterId: semesterIdFilter || undefined,
      });
      downloadBase64(base64, fileName, XLSX_MIME);
    } catch (error) {
      toast.error(getActionErrorMessage(error, "Could not export the timetable."));
    } finally {
      setExporting(false);
    }
  }

  const headerLabel =
    nowView.day === null
      ? "All days"
      : nowView.isFallbackDay
        ? `Nearest upcoming — ${DAY_LABELS[nowView.day]}`
        : nowView.activeShift
          ? `${DAY_LABELS[nowView.day]} · ${nowView.activeShift.name} (${nowView.activeShift.startTime}–${nowView.activeShift.endTime})`
          : quick === "now"
            ? `${DAY_LABELS[nowView.day]} · ${nowView.time}`
            : DAY_LABELS[nowView.day];

  const totalCount = nowView.inProgress.length + nowView.sessions.length;

  // The GRID: sessions laid out in Shift-rows x Day-columns, one grid per
  // structure group (studyMode + FT period — see now-grid.ts), read-only.
  const allSlots: SlotRow[] = [...nowView.inProgress, ...nowView.sessions];
  const slotById = new Map(allSlots.map((s) => [s.id, s]));
  const statusById = new Map<string, "NOW" | "NEXT">();
  for (const s of nowView.inProgress) statusById.set(s.id, "NOW");
  if (quick === "now") for (const s of nowView.sessions) statusById.set(s.id, "NEXT");

  const gridGroups = buildNowGrids(allSlots, shifts, nowView.day);

  function toGridSessions(
    groupSessions: ReturnType<typeof buildNowGrids>[number]["sessions"],
    showClassName: boolean
  ): ScheduleGridSession[] {
    return groupSessions.map((s) => ({
      id: s.id,
      assignmentId: slotById.get(s.id)?.assignment.id ?? "",
      courseName: s.courseName,
      lecturerName: s.lecturerName,
      className: showClassName ? s.className : undefined,
      roomLabel: s.roomLabel,
      dayOfWeek: s.dayOfWeek,
      startTime: s.startTime,
      endTime: s.endTime,
      crossPeriodOverride: s.crossPeriodOverride,
      status: statusById.get(s.id),
    }));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-muted/30 p-1">
          <Button
            type="button"
            size="sm"
            variant={quick === "now" ? "default" : "ghost"}
            onClick={selectNow}
          >
            Now
          </Button>

          {showGrouped ? (
            <>
              <span className="ml-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                FT
              </span>
              {ftShifts.map((shift) => (
                <ShiftButton
                  key={shift.id}
                  shift={shift}
                  selected={quick === shift.id}
                  onClick={() => table.setFilter("quick", shift.id)}
                />
              ))}
              <span className="ml-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                PT
              </span>
              {ptShifts.map((shift) => (
                <ShiftButton
                  key={shift.id}
                  shift={shift}
                  selected={quick === shift.id}
                  onClick={() => table.setFilter("quick", shift.id)}
                />
              ))}
            </>
          ) : (
            relevantShifts.map((shift) => (
              <ShiftButton
                key={shift.id}
                shift={shift}
                selected={quick === shift.id}
                onClick={() => table.setFilter("quick", shift.id)}
              />
            ))
          )}

          <Button
            type="button"
            size="sm"
            variant={quick === "full" ? "default" : "ghost"}
            onClick={() => table.setFilter("quick", "full")}
          >
            Full week
          </Button>
        </div>
        <Button type="button" variant="outline" onClick={handleExport} disabled={exporting}>
          {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          Export Excel
        </Button>
      </div>

      {shifts.length === 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border bg-muted/20 p-3 text-sm text-muted-foreground">
          <CalendarClock className="size-4 shrink-0" />
          <span>
            No shift templates have been created yet — add one to get quick shift-based filters here.
          </span>
          {onGoToShifts && (
            <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={onGoToShifts}>
              Go to Shifts <ArrowRight className="size-3.5" />
            </Button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="w-44">
          <SearchableSelect
            value={table.getFilter("classId") || ALL_VALUE}
            onValueChange={(value) => table.setFilter("classId", value)}
            items={[
              { value: ALL_VALUE, label: "All classes" },
              ...classes.map((c) => ({ value: c.id, label: formatClassLabel(c) })),
            ]}
            placeholder="Class"
            searchPlaceholder="Search classes…"
            className="w-full"
          />
        </div>
        <div className="w-44">
          <SearchableSelect
            value={table.getFilter("lecturerId") || ALL_VALUE}
            onValueChange={(value) => table.setFilter("lecturerId", value)}
            items={[
              { value: ALL_VALUE, label: "All lecturers" },
              ...lecturers.map((l) => ({ value: l.id, label: l.fullName })),
            ]}
            placeholder="Lecturer"
            searchPlaceholder="Search lecturers…"
            className="w-full"
          />
        </div>
        <div className="w-52">
          <SearchableSelect
            value={table.getFilter("roomId") || ALL_VALUE}
            onValueChange={(value) => table.setFilter("roomId", value)}
            items={[
              { value: ALL_VALUE, label: "All rooms" },
              ...roomsForFilter.map((r) => ({
                value: r.id,
                label: `${r.name} — ${r.campus.name}`,
                keywords: [r.campus.name],
              })),
            ]}
            placeholder="Room"
            searchPlaceholder="Search rooms…"
            className="w-full"
          />
        </div>
        <div className="w-44">
          <SearchableSelect
            value={campusIdFilter || ALL_VALUE}
            onValueChange={(value) => table.setFilter("campusId", value)}
            items={[
              { value: ALL_VALUE, label: "All campuses" },
              ...campuses.map((c) => ({ value: c.id, label: c.name })),
            ]}
            placeholder="Campus"
            searchPlaceholder="Search campuses…"
            className="w-full"
          />
        </div>
        <div className="w-52">
          <SearchableSelect
            value={semesterIdFilter || ALL_SEMESTERS_VALUE}
            onValueChange={(value) => table.setFilter("semesterId", value)}
            items={[
              { value: ALL_SEMESTERS_VALUE, label: "All semesters" },
              ...semesters.map((s) => ({
                value: s.id,
                label: `${s.name} (${s.academicYear.name})${s.isActive ? " — active" : ""}`,
              })),
            ]}
            placeholder="Semester"
            searchPlaceholder="Search semesters…"
            className="w-full"
          />
        </div>
        <div className="w-36">
          <Select value={dayFilterValue || ALL_VALUE} onValueChange={selectDay}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Day" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_VALUE}>All days</SelectItem>
              {ALL_DAYS_ORDER.map((d) => (
                <SelectItem key={d} value={d}>
                  {DAY_LABELS[d]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
          <RotateCcw className="size-3.5" />
          Reset Filters
        </Button>
      </div>

      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {quick === "now" && (
          <span className="size-2 rounded-full bg-green-500" aria-hidden />
        )}
        <span>
          {headerLabel}
          {totalCount > 0 &&
            ` — showing ${nowView.inProgress.length > 0 ? `${nowView.inProgress.length} in progress, ` : ""}${nowView.sessions.length} ${quick === "now" ? "upcoming" : "session" + (nowView.sessions.length === 1 ? "" : "s")}`}
        </span>
      </div>

      {totalCount === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-border bg-card py-16 text-muted-foreground">
          <CalendarX2 className="size-6" />
          <p className="text-sm">No sessions match your filters.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {gridGroups.map((group) => {
            const multiClass = new Set(group.sessions.map((s) => s.className)).size > 1;
            return (
              <div key={group.key} className="flex flex-col gap-2">
                {gridGroups.length > 1 && (
                  <p className="text-sm font-semibold text-foreground">{group.label}</p>
                )}
                <ScheduleGrid
                  interactive={false}
                  scale="full"
                  rows={group.rows}
                  days={group.days}
                  sessions={toGridSessions(group.sessions, multiClass)}
                  onEditSession={
                    onEdit
                      ? (id) => {
                          const slot = slotById.get(id);
                          if (slot) onEdit(slot);
                        }
                      : undefined
                  }
                  onDeleteSession={
                    onDelete
                      ? (id) => {
                          const slot = slotById.get(id);
                          if (slot) onDelete(slot);
                        }
                      : undefined
                  }
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
