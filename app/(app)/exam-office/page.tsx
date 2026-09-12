import { requirePermission } from "@/lib/auth";
import { getExamOfficePanelData, type ExamOfficePanelSearchParams } from "./queries";
import { ExamOfficeClient } from "./exam-office-client";

export default async function ExamOfficePage({
  searchParams,
}: {
  searchParams: Promise<ExamOfficePanelSearchParams>;
}) {
  // Page-level check on top of the layout gate — the same "the
  // server-side check is the real boundary, the layout/nav is cosmetic"
  // rule this app applies everywhere else.
  await requirePermission("exam.records.view");
  const params = await searchParams;
  const data = await getExamOfficePanelData(params);
  return <ExamOfficeClient {...data} />;
}
