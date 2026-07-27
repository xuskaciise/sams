import { getCurrentUser, getSessionContext } from "@/lib/auth";
import { getTimetablePanelData, type TimetablePanelSearchParams } from "./queries";
import { TimetableClient } from "./timetable-client";

export type TimetableSearchParams = TimetablePanelSearchParams;

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

  // campus.manage/room.manage/shift.manage are ADMIN-only — a DEAN (who
  // holds timetable.manage but not these) sees the Rooms/Campuses/Shifts
  // tabs read-only, no Add/Edit/Deactivate/Bulk-add controls. The server
  // actions are the real boundary either way; this only hides
  // controls that would just come back FORBIDDEN.
  const canManageCampuses = ctx?.permissions.has("campus.manage") ?? false;
  const canManageRooms = ctx?.permissions.has("room.manage") ?? false;
  const canManageShifts = ctx?.permissions.has("shift.manage") ?? false;

  return (
    <TimetableClient
      {...data}
      canManageCampuses={canManageCampuses}
      canManageRooms={canManageRooms}
      canManageShifts={canManageShifts}
    />
  );
}
