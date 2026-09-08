import type { DayOfWeek, Period, StudyMode } from "@prisma/client";
import { VALID_DAYS_BY_STUDY_MODE, ALL_DAYS_ORDER } from "@/lib/timetable-days";
import { formatClassLabel } from "@/lib/class-label";
import { timeToMinutes } from "@/lib/timetable-conflicts";
import { formatTimeRange12h } from "@/lib/time-format";

// Pure layout logic for the Timetable "super filter" report view's GRID
// rendering — shared by the client (now-view-client.tsx renders each group
// with the read-only <ScheduleGrid>) and the server (exportTimetable emits
// one sheet per group in the same shape), so the on-screen grid and its
// Excel export can never disagree.
//
// Multi-class handling (requirement 4): sessions are grouped by their
// class's (studyMode, period) — a "structure group". This is because the
// grid's day COLUMNS come from VALID_DAYS_BY_STUDY_MODE[studyMode] and its
// shift ROWS come from the shifts for that studyMode (+ period for FT), so
// two classes can only share one grid's axes when they share that
// structure. Classes that DO share it are combined into ONE grid (each
// card shows its class label) — the more useful "everything happening in
// this shift right now, across the faculty" view, and it avoids a wall of
// near-identical single-row grids. Classes with different structure get
// their own grid, stacked (like the auto-generate multi-class overview).

export interface NowGridInputSlot {
  id: string;
  dayOfWeek: DayOfWeek;
  startTime: string;
  endTime: string;
  crossPeriodOverride?: boolean;
  assignment: {
    course: { name: string };
    lecturer: { fullName: string };
    class: {
      id: string;
      name: string;
      currentSemesterNumber: number | null;
      studyMode: StudyMode | null;
      period: Period | null;
    };
  };
  room: { name: string; campus: { name: string } };
}

export interface NowGridShift {
  id: string;
  name: string;
  studyMode: StudyMode;
  period: Period | null;
  startTime: string;
  endTime: string;
}

export interface NowGridRow {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  // True for a row added to a group ONLY to home a cross-period-override
  // session (whose real time belongs to the other period's shift window).
  // ScheduleGrid tints these violet with a "cross-period" sublabel.
  crossPeriod?: boolean;
}

export interface NowGridSession {
  id: string;
  courseName: string;
  lecturerName: string;
  className: string;
  roomLabel: string;
  dayOfWeek: DayOfWeek;
  startTime: string;
  endTime: string;
  crossPeriodOverride: boolean;
}

export interface NowGridGroup {
  key: string;
  label: string;
  studyMode: StudyMode | null;
  period: Period | null;
  rows: NowGridRow[];
  days: DayOfWeek[];
  sessions: NowGridSession[];
}

interface GroupMeta {
  key: string;
  label: string;
  order: number;
  studyMode: StudyMode | null;
  period: Period | null;
}

function groupMetaFor(studyMode: StudyMode | null, period: Period | null): GroupMeta {
  if (studyMode === "FT") {
    if (period === "MORNING")
      return { key: "FT:MORNING", label: "Full-time — Morning", order: 0, studyMode, period };
    if (period === "AFTERNOON")
      return { key: "FT:AFTERNOON", label: "Full-time — Afternoon", order: 1, studyMode, period };
    return { key: "FT:NONE", label: "Full-time", order: 2, studyMode, period: null };
  }
  if (studyMode === "PT") {
    return { key: "PT", label: "Part-time", order: 3, studyMode, period: null };
  }
  return { key: "UNSPEC", label: "Unspecified study mode", order: 4, studyMode: null, period: null };
}

function shiftsForGroup(shifts: NowGridShift[], meta: GroupMeta): NowGridShift[] {
  const pick =
    meta.studyMode === null
      ? shifts
      : meta.studyMode === "PT"
        ? shifts.filter((s) => s.studyMode === "PT")
        : meta.period
          ? shifts.filter((s) => s.studyMode === "FT" && s.period === meta.period)
          : shifts.filter((s) => s.studyMode === "FT");
  return [...pick].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
}

function timeInWindow(start: string, r: { startTime: string; endTime: string }): boolean {
  const t = timeToMinutes(start);
  return t >= timeToMinutes(r.startTime) && t < timeToMinutes(r.endTime);
}

// Synthesize one row per distinct session time range — used when a group
// has no real Shift templates for its studyMode/period at all.
function synthesizedRows(sessions: NowGridSession[]): NowGridRow[] {
  const seen = new Map<string, NowGridRow>();
  for (const s of sessions) {
    const key = `${s.startTime}-${s.endTime}`;
    const existing = seen.get(key);
    if (existing) {
      if (!s.crossPeriodOverride) existing.crossPeriod = false;
      continue;
    }
    seen.set(key, {
      id: `t:${key}`,
      name: formatTimeRange12h(s.startTime, s.endTime),
      startTime: s.startTime,
      endTime: s.endTime,
      crossPeriod: s.crossPeriodOverride,
    });
  }
  return [...seen.values()].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
}

// Every session needs a home row AT ITS ACTUAL TIME. Start from the
// group's own-period Shift templates; then, for any CROSS-PERIOD-OVERRIDE
// session whose start time falls outside ALL of them (its real time
// belongs to the OTHER period's shift window), ADD a row at that time —
// named from whichever same-study-mode shift window contains it (either
// period), else the raw range, and tinted violet as "cross-period".
// Without this, an 11:00 cross-period session was dropped into the
// numerically "closest" own-period row (see schedule-grid.tsx's
// rowForSession) — e.g. showing under a 13:00 Afternoon shift row. A
// non-cross-period session that drifts outside every window keeps the
// pre-existing closest-row fallback (a rare hand-retimed edge — not what
// this fix is about).
function rowsForGroup(meta: GroupMeta, shifts: NowGridShift[], sessions: NowGridSession[]): NowGridRow[] {
  const real: NowGridRow[] = shiftsForGroup(shifts, meta).map((s) => ({
    id: s.id,
    name: s.name,
    startTime: s.startTime,
    endTime: s.endTime,
  }));
  if (real.length === 0) return synthesizedRows(sessions);

  const sameModeShifts = [...shifts]
    .filter((s) => meta.studyMode === null || s.studyMode === meta.studyMode)
    .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));

  const extra = new Map<string, NowGridRow>();
  for (const s of sessions) {
    if (!s.crossPeriodOverride) continue;
    if (real.some((r) => timeInWindow(s.startTime, r))) continue;
    const key = `${s.startTime}-${s.endTime}`;
    if (extra.has(key)) continue;
    const shift = sameModeShifts.find((sh) => timeInWindow(s.startTime, sh));
    extra.set(
      key,
      shift
        ? {
            id: shift.id,
            name: shift.name,
            startTime: shift.startTime,
            endTime: shift.endTime,
            crossPeriod: true,
          }
        : {
            id: `t:${key}`,
            name: formatTimeRange12h(s.startTime, s.endTime),
            startTime: s.startTime,
            endTime: s.endTime,
            crossPeriod: true,
          }
    );
  }

  return [...real, ...extra.values()].sort(
    (a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime)
  );
}

function daysForGroup(meta: GroupMeta, day: DayOfWeek | null): DayOfWeek[] {
  if (day !== null) return [day];
  const valid = meta.studyMode ? VALID_DAYS_BY_STUDY_MODE[meta.studyMode] : ALL_DAYS_ORDER;
  return ALL_DAYS_ORDER.filter((d) => valid.includes(d));
}

function toSession(slot: NowGridInputSlot): NowGridSession {
  return {
    id: slot.id,
    courseName: slot.assignment.course.name,
    lecturerName: slot.assignment.lecturer.fullName,
    className: formatClassLabel(slot.assignment.class),
    roomLabel: `${slot.room.name} — ${slot.room.campus.name}`,
    dayOfWeek: slot.dayOfWeek,
    startTime: slot.startTime,
    endTime: slot.endTime,
    crossPeriodOverride: !!slot.crossPeriodOverride,
  };
}

function sortSessions(sessions: NowGridSession[]): NowGridSession[] {
  return [...sessions].sort(
    (a, b) =>
      ALL_DAYS_ORDER.indexOf(a.dayOfWeek) - ALL_DAYS_ORDER.indexOf(b.dayOfWeek) ||
      timeToMinutes(a.startTime) - timeToMinutes(b.startTime)
  );
}

// "structure" (the default) groups sessions by their class's
// (studyMode, period) — classes that share that structure are combined
// into ONE grid. "class" puts EACH class in its own grid (used when the
// Timetable Report's Semester Level filter is active — see CLAUDE.md), so
// every class gets its own clearly-headed section; rows/days still come
// from that class's own studyMode/period, so FT/PT + Morning/Afternoon
// rules are respected per class.
export type NowGridGrouping = "structure" | "class";

// `day` is the single day already resolved by resolveNowView (today for
// "now", the shift's effective day, or an explicit Day filter) — null only
// for "full week, no day filter", in which case each group shows its whole
// valid week.
export function buildNowGrids(
  slots: NowGridInputSlot[],
  shifts: NowGridShift[],
  day: DayOfWeek | null,
  groupBy: NowGridGrouping = "structure"
): NowGridGroup[] {
  if (groupBy === "class") return buildClassGrids(slots, shifts, day);

  const byKey = new Map<string, { meta: GroupMeta; sessions: NowGridSession[] }>();

  for (const slot of slots) {
    const meta = groupMetaFor(slot.assignment.class.studyMode, slot.assignment.class.period);
    if (!byKey.has(meta.key)) byKey.set(meta.key, { meta, sessions: [] });
    byKey.get(meta.key)!.sessions.push(toSession(slot));
  }

  return [...byKey.values()]
    .sort((a, b) => a.meta.order - b.meta.order)
    .map(({ meta, sessions }) => {
      const sorted = sortSessions(sessions);
      return {
        key: meta.key,
        label: meta.label,
        studyMode: meta.studyMode,
        period: meta.period,
        rows: rowsForGroup(meta, shifts, sorted),
        days: daysForGroup(meta, day),
        sessions: sorted,
      };
    });
}

// One NowGridGroup per class. Ordered by structure group first
// (FT-Morning, FT-Afternoon, FT, PT, Unspecified) then class label, so
// related classes still sit together. A class with zero sessions after the
// other filters simply produces no group — sections with no matching
// sessions are hidden, not shown empty.
function buildClassGrids(
  slots: NowGridInputSlot[],
  shifts: NowGridShift[],
  day: DayOfWeek | null
): NowGridGroup[] {
  const byClass = new Map<
    string,
    { cls: NowGridInputSlot["assignment"]["class"]; sessions: NowGridSession[] }
  >();

  for (const slot of slots) {
    const cls = slot.assignment.class;
    if (!byClass.has(cls.id)) byClass.set(cls.id, { cls, sessions: [] });
    byClass.get(cls.id)!.sessions.push(toSession(slot));
  }

  return [...byClass.entries()]
    .map(([id, { cls, sessions }]) => {
      const meta = groupMetaFor(cls.studyMode, cls.period);
      const sorted = sortSessions(sessions);
      return {
        key: `class:${id}`,
        label: formatClassLabel(cls),
        studyMode: cls.studyMode,
        period: cls.period,
        rows: rowsForGroup(meta, shifts, sorted),
        days: daysForGroup(meta, day),
        sessions: sorted,
      };
    })
    .sort(
      (a, b) =>
        groupMetaFor(a.studyMode, a.period).order - groupMetaFor(b.studyMode, b.period).order ||
        a.label.localeCompare(b.label)
    );
}

// Which grid ROW a session belongs to — its [start, end) shift window, or
// the closest row if a hand-typed time moved it outside every window.
// Same heuristic components/timetable/schedule-grid.tsx uses on screen;
// duplicated here (a small pure fn) so the export can compute the same
// placement without importing that "use client" component.
export function rowIdForSession(session: { startTime: string }, rows: NowGridRow[]): string | null {
  if (rows.length === 0) return null;
  const t = timeToMinutes(session.startTime);
  const contained = rows.find((r) => t >= timeToMinutes(r.startTime) && t < timeToMinutes(r.endTime));
  if (contained) return contained.id;
  return [...rows].sort(
    (a, b) => Math.abs(timeToMinutes(a.startTime) - t) - Math.abs(timeToMinutes(b.startTime) - t)
  )[0].id;
}
