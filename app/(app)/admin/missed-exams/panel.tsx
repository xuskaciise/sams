import { getCurrentUser } from "@/lib/auth";
import { getMissedExamPanelData, type MissedExamPanelSearchParams } from "./queries";
import { MissedExamsClient } from "./missed-exams-client";

export type MissedExamsSearchParams = MissedExamPanelSearchParams;

// Renders identically whether reached via /admin/missed-exams or
// /dean/missed-exams (see dean/missed-exams/page.tsx, which imports this
// same panel) — getMissedExamPanelData re-derives the real scope from the
// caller's role every time, so which URL got them here never matters.
export async function MissedExamsPanel({
  searchParams,
}: {
  searchParams: MissedExamsSearchParams;
}) {
  const user = await getCurrentUser();
  const data = await getMissedExamPanelData(user!.id, searchParams);

  return <MissedExamsClient {...data} />;
}
