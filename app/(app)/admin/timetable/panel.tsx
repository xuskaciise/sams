import type { DayOfWeek } from "@prisma/client";
import { getCurrentUser, getSessionContext } from "@/lib/auth";
import { classifyForNow, getCurrentDayAndTime, matchesAnyShiftRange } from "@/lib/timetable-now";
import { ALL_DAYS_ORDER } from "@/lib/timetable-days";
import { getTimetablePanelData, type TimetablePanelSearchParams, type SlotRow, type TimetablePanelData } from "./queries";
import { TimetableClient } from "./timetable-client";

export interface TimetableSearchParams extends TimetablePanelSearchParams {
  quick?: string;
  dayOfWeek?: string;
}

type ShiftOption = TimetablePanelData["shifts"][number];

export interface NowViewData {
  // "now" | "full" | a Shift id. An unrecognized/stale shift id (e.g. one
  // that's since been deactivated) falls back to "full", same as an
  // omitted value falls back to "now".
  quick: string;
  // Set only when `quick` resolved to a real Shift id — the record itself,
  // for the UI to show its name/time range in the header.
  activeShift: ShiftOption | null;
  // The day being shown. null only for "full" with no explicit day filter
  // (every valid day is shown at once, grouped in calendar order).
  day: DayOfWeek | null;
  // The server's current clock time ("HH:MM") — display only (the header
  // line), computed once per request; this app has no client-side polling
  // anywhere, so it reflects "now" as of the last page load/filter change.
  time: string;
  // Only ever true for "now" — the resolved day is a future day because
  // nothing was left in progress or upcoming today.
  isFallbackDay: boolean;
  // Only ever populated for "now".
  inProgress: SlotRow[];
  // "now": today's remaining sessions (soonest first). A shift quick
  // filter: the resolved day's (today, unless an explicit Day filter is
  // set) sessions inside that Shift's time window. "full": every session
  // matching the filters (and the day filter, if set), sorted by day then
  // start time.
  sessions: SlotRow[];
}

const VALID_DAYS = new Set(ALL_DAYS_ORDER);

function parseQuick(value: string | undefined): string {
  return value && value.trim() !== "" ? value : "now";
}

function parseDayOfWeek(value: string | undefined): DayOfWeek | undefined {
  return VALID_DAYS.has(value as DayOfWeek) ? (value as DayOfWeek) : undefined;
}

function daySortKey(day: DayOfWeek): number {
  return ALL_DAYS_ORDER.indexOf(day);
}

// Computed entirely server-side from the SAME already-scoped `slots` list
// getTimetablePanelData already fetched (Class/Lecturer/Room/Campus/
// Semester filters + dean-scope all already applied at the DB layer) —
// the day/quick narrowing below happens in-memory against that already-
// authorized set, never against unfiltered data, so it satisfies "not
// client-side hiding" without a second round trip. There is only ONE
// timetable view now (no separate Weekly Grid tab) — Day is just another
// filter dimension alongside `quick`, not a mode gated behind "full".
//
// An explicit Day filter always wins over "now"'s live/today-only
// semantics — picking a day means "show that day's sessions," full stop,
// which is why "now" only takes its own branch when NO day is set (the
// client-side "Now" button clears any Day filter in the same navigation
// for exactly this reason, see now-view-client.tsx). A Shift, on the
// other hand, is a pure time-of-day narrowing that composes WITH a Day
// filter — it resolves against whichever day is in effect (the explicit
// Day filter, or today if none is set), not always "today."
function resolveNowView(
  slots: SlotRow[],
  shifts: ShiftOption[],
  quick: string,
  dayOfWeek: DayOfWeek | undefined
): NowViewData {
  const now = new Date();
  const { day: today, time } = getCurrentDayAndTime(now);

  if (quick === "now" && !dayOfWeek) {
    const { day, isFallbackDay, inProgress, next } = classifyForNow(slots, now);
    return { quick, activeShift: null, day, time, isFallbackDay, inProgress, sessions: next };
  }

  const shift = shifts.find((s) => s.id === quick);
  if (shift) {
    const effectiveDay = dayOfWeek ?? today;
    const sessions = slots
      .filter((s) => s.dayOfWeek === effectiveDay && matchesAnyShiftRange(s.startTime, [shift]))
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
    return {
      quick: shift.id,
      activeShift: shift,
      day: effectiveDay,
      time,
      isFallbackDay: false,
      inProgress: [],
      sessions,
    };
  }

  // "full", "now" combined with an explicit Day, or an unrecognized value
  // (e.g. a deactivated shift's stale id) — all fall back to the plain
  // filtered/day-scoped list.
  const filtered = dayOfWeek ? slots.filter((s) => s.dayOfWeek === dayOfWeek) : slots;
  const sessions = [...filtered].sort(
    (a, b) => daySortKey(a.dayOfWeek) - daySortKey(b.dayOfWeek) || a.startTime.localeCompare(b.startTime)
  );
  return { quick: "full", activeShift: null, day: dayOfWeek ?? null, time, isFallbackDay: false, inProgress: [], sessions };
}

// Renders identically whether reached via /admin/timetable or
// /dean/timetable (see dean/timetable/page.tsx, which imports this same
// panel) — getTimetablePanelData re-derives the real scope from the
// caller's role every time, so which URL got them here never matters.
export async function TimetablePanel({
  searchParams,
}: {
  searchParams: TimetableSearchParams;
}) {
  const user = await getCurrentUser();
  const [data, ctx] = await Promise.all([
    getTimetablePanelData(user!.id, searchParams),
    getSessionContext(),
  ]);

  // shift.manage is ADMIN-only — a DEAN (who holds timetable.manage but
  // not this) sees the Shifts tab read-only, no Add/Edit/Deactivate
  // controls. Campus/Room management moved to the standalone
  // /admin/campuses section (see ../campuses/panel.tsx) — this panel only
  // reads rooms/campuses as reference data for the room picker/filters.
  // The server actions are the real boundary either way; this only hides
  // controls that would just come back FORBIDDEN.
  const canManageShifts = ctx?.permissions.has("shift.manage") ?? false;

  const quick = parseQuick(searchParams.quick);
  const dayOfWeek = parseDayOfWeek(searchParams.dayOfWeek);
  const nowView = resolveNowView(data.slots, data.shifts, quick, dayOfWeek);

  return <TimetableClient {...data} canManageShifts={canManageShifts} nowView={nowView} />;
}
