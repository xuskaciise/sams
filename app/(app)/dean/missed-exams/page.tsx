import {
  MissedExamsPanel,
  type MissedExamsSearchParams,
} from "../../admin/missed-exams/panel";

// Same panel as /admin/missed-exams — see that file's comment for why the
// scoping is safe regardless of which route rendered it.
export default async function DeanMissedExamsPage({
  searchParams,
}: {
  searchParams: Promise<MissedExamsSearchParams>;
}) {
  const params = await searchParams;
  return <MissedExamsPanel searchParams={params} />;
}
