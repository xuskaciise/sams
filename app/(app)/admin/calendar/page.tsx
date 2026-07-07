import { HubTabs } from "@/components/layout/hub-tabs";
import { PageHeader } from "@/components/layout/page-header";
import { AcademicYearsPanel } from "../academic-years/panel";
import { SemestersPanel } from "../semesters/panel";

const TABS = [
  { value: "academic-years", label: "Academic Years" },
  { value: "semesters", label: "Semesters" },
];

export default async function AcademicCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const activeTab = TABS.some((t) => t.value === tab) ? tab! : "academic-years";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Academic Calendar"
        description="Academic years and semesters."
      />
      <HubTabs basePath="/admin/calendar" activeTab={activeTab} tabs={TABS} />
      {activeTab === "academic-years" && <AcademicYearsPanel />}
      {activeTab === "semesters" && <SemestersPanel />}
    </div>
  );
}
