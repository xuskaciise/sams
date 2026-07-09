import { PageHeader } from "@/components/layout/page-header";
import { ReportsPanel } from "./panel";

export default function DeanReportsPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Reports"
        description="Read-only per-course, per-class, and per-student results, with Excel export."
      />
      <ReportsPanel />
    </div>
  );
}
