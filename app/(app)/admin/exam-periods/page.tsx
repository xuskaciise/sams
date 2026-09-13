import { requirePermission } from "@/lib/auth";
import { ExamPeriodsPanel } from "./panel";

export default async function ExamPeriodsPage() {
  // Page-level check on top of the admin section layout gate — the
  // real boundary, same rule as every other page in this app.
  await requirePermission("exam.periods.manage");
  return <ExamPeriodsPanel />;
}
