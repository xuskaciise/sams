import { HubTabs } from "@/components/layout/hub-tabs";
import { PageHeader } from "@/components/layout/page-header";
import { DepartmentsPanel } from "../departments/panel";
import { ProgramsPanel } from "../programs/panel";
import { ClassesPanel } from "../classes/panel";

const TABS = [
  { value: "departments", label: "Departments" },
  { value: "programs", label: "Programs" },
  { value: "classes", label: "Classes" },
];

export default async function AcademicStructurePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const activeTab = TABS.some((t) => t.value === tab) ? tab! : "departments";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Academic Structure"
        description="Departments, programs, and classes."
      />
      <HubTabs basePath="/admin/structure" activeTab={activeTab} tabs={TABS} />
      {activeTab === "departments" && <DepartmentsPanel />}
      {activeTab === "programs" && <ProgramsPanel />}
      {activeTab === "classes" && <ClassesPanel />}
    </div>
  );
}
