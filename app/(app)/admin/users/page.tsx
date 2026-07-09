import { HubTabs } from "@/components/layout/hub-tabs";
import { UsersPanel, type UsersSearchParams } from "./panel";
import { RolesPanel } from "../roles/panel";

const TABS = [
  { value: "users", label: "Users" },
  { value: "roles", label: "Roles & Permissions" },
];

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<UsersSearchParams & { tab?: string }>;
}) {
  const params = await searchParams;
  const activeTab = TABS.some((t) => t.value === params.tab)
    ? params.tab!
    : "users";

  return (
    <div className="flex flex-col gap-6">
      <HubTabs basePath="/admin/users" activeTab={activeTab} tabs={TABS} />
      {activeTab === "users" && <UsersPanel searchParams={params} />}
      {activeTab === "roles" && <RolesPanel />}
    </div>
  );
}
