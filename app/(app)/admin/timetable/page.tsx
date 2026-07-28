import { redirect } from "next/navigation";
import { TimetablePanel, type TimetableSearchParams } from "./panel";

// Campus/Room management used to live as tabs on this page
// (?tab=campuses / ?tab=rooms) — they've moved to the standalone
// /admin/campuses section. Forward any old link so nothing 404s.
const MOVED_TABS: Record<string, string> = {
  campuses: "campuses",
  rooms: "rooms",
};

export default async function TimetablePage({
  searchParams,
}: {
  searchParams: Promise<TimetableSearchParams & { tab?: string }>;
}) {
  const { tab, ...params } = await searchParams;
  if (tab && MOVED_TABS[tab]) {
    redirect(`/admin/campuses?tab=${MOVED_TABS[tab]}`);
  }
  return <TimetablePanel searchParams={params} />;
}
