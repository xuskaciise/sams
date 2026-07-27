import { TimetablePanel, type TimetableSearchParams } from "./panel";

export default async function TimetablePage({
  searchParams,
}: {
  searchParams: Promise<TimetableSearchParams>;
}) {
  const params = await searchParams;
  return <TimetablePanel searchParams={params} />;
}
