import { HubTabs } from "@/components/layout/hub-tabs";
import { PageHeader } from "@/components/layout/page-header";
import { LecturersPanel } from "./panel";
import { LecturerAccountsPanel } from "../lecturer-accounts/panel";

const TABS = [
  { value: "lecturers", label: "Lecturers" },
  { value: "lecturer-accounts", label: "Lecturer Accounts" },
];

export default async function LecturersHubPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    departmentId?: string;
    q?: string;
    page?: string;
    pageSize?: string;
  }>;
}) {
  const params = await searchParams;
  const { tab, departmentId } = params;
  const activeTab = TABS.some((t) => t.value === tab) ? tab! : "lecturers";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Lecturers"
        description="Registration and account generation for lecturers."
      />
      <HubTabs basePath="/admin/lecturers" activeTab={activeTab} tabs={TABS} />
      {activeTab === "lecturers" && <LecturersPanel searchParams={params} />}
      {activeTab === "lecturer-accounts" && (
        <LecturerAccountsPanel departmentId={departmentId} />
      )}
    </div>
  );
}
