import { redirect } from "next/navigation";
import { TimetablePanel, type TimetableSearchParams } from "../../admin/timetable/panel";

// Same panel as /admin/timetable — see that file's comment for why the
// scoping is safe regardless of which route rendered it.
//
// Campus/Room management used to live as read-only tabs on this page
// (?tab=campuses / ?tab=rooms) — they've moved to the ADMIN-only
// /admin/campuses section, which a Dean can't reach. Forward an old link
// back to this page's own default view instead of a route they'd just
// get bounced from.
export default async function DeanTimetablePage({
  searchParams,
}: {
  searchParams: Promise<TimetableSearchParams & { tab?: string }>;
}) {
  const { tab, ...params } = await searchParams;
  if (tab === "campuses" || tab === "rooms") {
    redirect("/dean/timetable");
  }
  return <TimetablePanel searchParams={params} />;
}
