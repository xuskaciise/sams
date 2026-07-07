import { HubTabs } from "@/components/layout/hub-tabs";
import { PageHeader } from "@/components/layout/page-header";
import { StudentsPanel } from "./panel";
import { StudentAccountsPanel } from "../student-accounts/panel";
import { EnrollmentsPanel } from "../enrollments/panel";
import { ClassPromotionPanel } from "../class-promotion/panel";

const TABS = [
  { value: "students", label: "Students" },
  { value: "student-accounts", label: "Student Accounts" },
  { value: "enrollments", label: "Enrollments" },
  { value: "class-promotion", label: "Class Promotion" },
];

export default async function StudentsHubPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    classId?: string;
    courseId?: string;
    sourceClassId?: string;
  }>;
}) {
  const { tab, classId, courseId, sourceClassId } = await searchParams;
  const activeTab = TABS.some((t) => t.value === tab) ? tab! : "students";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Students"
        description="Registration, accounts, enrollments, and class promotion."
      />
      <HubTabs basePath="/admin/students" activeTab={activeTab} tabs={TABS} />
      {activeTab === "students" && <StudentsPanel />}
      {activeTab === "student-accounts" && (
        <StudentAccountsPanel classId={classId} />
      )}
      {activeTab === "enrollments" && (
        <EnrollmentsPanel classId={classId} courseId={courseId} />
      )}
      {activeTab === "class-promotion" && (
        <ClassPromotionPanel sourceClassId={sourceClassId} />
      )}
    </div>
  );
}
