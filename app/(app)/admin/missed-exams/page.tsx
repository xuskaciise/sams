import { MissedExamsPanel, type MissedExamsSearchParams } from "./panel";

export default async function MissedExamsPage({
  searchParams,
}: {
  searchParams: Promise<MissedExamsSearchParams>;
}) {
  const params = await searchParams;
  return <MissedExamsPanel searchParams={params} />;
}
