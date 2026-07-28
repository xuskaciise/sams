import { HubTabs } from "@/components/layout/hub-tabs";
import { PageHeader } from "@/components/layout/page-header";
import { CampusesPanel } from "./panel";
import { RoomsPanel } from "../rooms/panel";

const TABS = [
  { value: "campuses", label: "Campuses" },
  { value: "rooms", label: "Rooms" },
];

export default async function CampusesHubPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const activeTab = TABS.some((t) => t.value === tab) ? tab! : "campuses";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Campuses"
        description="Physical campuses and the rooms that belong to them."
      />
      <HubTabs basePath="/admin/campuses" activeTab={activeTab} tabs={TABS} />
      {activeTab === "campuses" && <CampusesPanel />}
      {activeTab === "rooms" && <RoomsPanel />}
    </div>
  );
}
