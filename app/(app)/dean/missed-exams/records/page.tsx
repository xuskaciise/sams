import {
  MissedExamsPanel,
  type MissedExamsSearchParams,
} from "../../../admin/missed-exams/panel";

// Same panel as /admin/missed-exams/records — scope is re-derived from the
// caller's role inside the queries, so the route never matters.
export default async function DeanMissedExamRecordsPage({
  searchParams,
}: {
  searchParams: Promise<MissedExamsSearchParams>;
}) {
  const params = await searchParams;
  return <MissedExamsPanel searchParams={params} mode="records" />;
}
