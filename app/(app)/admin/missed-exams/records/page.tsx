import { MissedExamsPanel, type MissedExamsSearchParams } from "../panel";

export default async function MissedExamRecordsPage({
  searchParams,
}: {
  searchParams: Promise<MissedExamsSearchParams>;
}) {
  const params = await searchParams;
  return <MissedExamsPanel searchParams={params} mode="records" />;
}
