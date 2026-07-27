import { TimetablePanel, type TimetableSearchParams } from "../../admin/timetable/panel";

// Same panel as /admin/timetable — see that file's comment for why the
// scoping is safe regardless of which route rendered it.
export default async function DeanTimetablePage({
  searchParams,
}: {
  searchParams: Promise<TimetableSearchParams>;
}) {
  const params = await searchParams;
  return <TimetablePanel searchParams={params} />;
}
