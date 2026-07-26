import {
  DailyLogPanel,
  type DailyLogSearchParams,
} from "../../admin/daily-log/panel";

// Same panel as /admin/daily-log — see that file's comment for why the
// scoping is safe regardless of which route rendered it.
export default async function DeanDailyLogPage({
  searchParams,
}: {
  searchParams: Promise<DailyLogSearchParams>;
}) {
  const params = await searchParams;
  return <DailyLogPanel searchParams={params} />;
}
