import { getCurrentUser } from "@/lib/auth";
import { getDailyLogPanelData, type DailyLogPanelSearchParams } from "./queries";
import { DailyLogClient } from "./daily-log-client";

export type DailyLogSearchParams = DailyLogPanelSearchParams;

// Renders identically whether reached via /admin/daily-log or
// /dean/daily-log (see dean/daily-log/page.tsx, which imports this same
// panel) — getDailyLogPanelData re-derives the real scope from the
// caller's role every time, so which URL got them here never matters.
export async function DailyLogPanel({
  searchParams,
}: {
  searchParams: DailyLogSearchParams;
}) {
  const user = await getCurrentUser();
  const data = await getDailyLogPanelData(user!.id, searchParams);

  return <DailyLogClient {...data} />;
}
