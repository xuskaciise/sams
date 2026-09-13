import { getSessionContext } from "@/lib/auth";
import { getMissedExamPanelData, type MissedExamPanelSearchParams } from "./queries";
import { MissedExamsClient } from "./missed-exams-client";

export type MissedExamsSearchParams = MissedExamPanelSearchParams;

// Renders identically whether reached via /admin/missed-exams or
// /dean/missed-exams (see dean/missed-exams/page.tsx, which imports this
// same panel) — getMissedExamPanelData re-derives the real scope from
// the caller's role every time, so which URL got them here never
// matters.
export async function MissedExamsPanel({
  searchParams,
}: {
  searchParams: MissedExamsSearchParams;
}) {
  const ctx = await getSessionContext();
  const data = await getMissedExamPanelData(ctx!.user.id, searchParams);

  // Edit is implicit (this whole page already requires exam.records.manage
  // to reach); Delete is a strictly separate, independently-grantable key
  // — canDelete controls only whether the client SHOWS the Delete action.
  // The real boundary is deleteMissedExamRecord's own requirePermission
  // check server-side.
  const canDelete = ctx!.permissions.has("exam.records.delete");

  return <MissedExamsClient {...data} canDelete={canDelete} />;
}
