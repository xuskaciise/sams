import { PageHeader } from "@/components/layout/page-header";
import { TransfersPanel } from "./panel";

export default function TransfersPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Ownership Transfer"
        description="Reassign a lecturer's course assignment, with a mandatory reason."
      />
      <TransfersPanel />
    </div>
  );
}
