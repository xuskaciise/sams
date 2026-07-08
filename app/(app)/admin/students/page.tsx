import { HubTabs } from "@/components/layout/hub-tabs";
import { PageHeader } from "@/components/layout/page-header";
import { StudentsPanel } from "./panel";
import { StudentAccountsPanel } from "../student-accounts/panel";
import { EnrollmentsPanel } from "../enrollments/panel";
import { TransferStudentsPanel } from "../transfer-students/panel";

const TABS = [
  { value: "students", label: "Students" },
  { value: "student-accounts", label: "Student Accounts" },
  { value: "enrollments", label: "Enrollments" },
  { value: "transfer-students", label: "Transfer Students" },
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
        description="Registration, accounts, enrollments, and student transfers."
      />
      <HubTabs basePath="/admin/students" activeTab={activeTab} tabs={TABS} />
      {activeTab === "students" && <StudentsPanel />}
      {activeTab === "student-accounts" && (
        <StudentAccountsPanel classId={classId} />
      )}
      {activeTab === "enrollments" && (
        <EnrollmentsPanel classId={classId} courseId={courseId} />
      )}
      {activeTab === "transfer-students" && (
        <TransferStudentsPanel sourceClassId={sourceClassId} />
      )}
    </div>
  );
}
