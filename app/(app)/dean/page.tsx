import { HubTabs } from "@/components/layout/hub-tabs";
import { PageHeader } from "@/components/layout/page-header";
import { TransfersPanel } from "./transfers/panel";
import { CloseSemesterPanel } from "./close-semester/panel";
import { ReportsPanel } from "./reports/panel";

const TABS = [
  { value: "transfers", label: "Ownership Transfer" },
  { value: "close-semester", label: "Close Semester" },
  { value: "reports", label: "Reports" },
];

export default async function DeanPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const activeTab = TABS.some((t) => t.value === tab) ? tab! : "transfers";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Dean"
        description="Ownership transfers, closing the semester, and course/class/student reports."
      />
      <HubTabs basePath="/dean" activeTab={activeTab} tabs={TABS} />
      {activeTab === "transfers" && <TransfersPanel />}
      {activeTab === "close-semester" && <CloseSemesterPanel />}
      {activeTab === "reports" && <ReportsPanel />}
    </div>
  );
}
