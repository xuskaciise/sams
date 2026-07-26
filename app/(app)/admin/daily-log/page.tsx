import { DailyLogPanel, type DailyLogSearchParams } from "./panel";

export default async function DailyLogPage({
  searchParams,
}: {
  searchParams: Promise<DailyLogSearchParams>;
}) {
  const params = await searchParams;
  return <DailyLogPanel searchParams={params} />;
}
