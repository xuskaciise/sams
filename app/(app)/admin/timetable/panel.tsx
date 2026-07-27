import { getCurrentUser } from "@/lib/auth";
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
  const data = await getTimetablePanelData(user!.id, searchParams);

  return <TimetableClient {...data} />;
}
