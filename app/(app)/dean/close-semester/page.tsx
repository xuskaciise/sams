import { PageHeader } from "@/components/layout/page-header";
import { CloseSemesterPanel } from "./panel";

export default function CloseSemesterPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Close Semester"
        description="Lock the active semester's assessments — permanent, no more entry, corrections, or publishing."
      />
      <CloseSemesterPanel />
    </div>
  );
}
