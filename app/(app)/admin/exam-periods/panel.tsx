import { getExamPeriodsPanelData } from "./queries";
import { ExamPeriodsClient } from "./exam-periods-client";

export async function ExamPeriodsPanel() {
  const data = await getExamPeriodsPanelData();
  return <ExamPeriodsClient {...data} />;
}
