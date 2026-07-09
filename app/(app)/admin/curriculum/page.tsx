import { HubTabs } from "@/components/layout/hub-tabs";
import { PageHeader } from "@/components/layout/page-header";
import { CoursesPanel } from "../courses/panel";
import { CoursePlansPanel } from "../course-plans/panel";
import { AssignmentsPanel } from "../assignments/panel";

const TABS = [
  { value: "courses", label: "Courses" },
  { value: "course-plans", label: "Course Plans" },
  { value: "assignments", label: "Assignments" },
];

export default async function CurriculumPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    classId?: string;
    semesterNumber?: string;
    courseId?: string;
    lecturerId?: string;
    semesterId?: string;
    q?: string;
    page?: string;
    pageSize?: string;
  }>;
}) {
  const params = await searchParams;
  const { tab, classId, semesterNumber } = params;
  const activeTab = TABS.some((t) => t.value === tab) ? tab! : "courses";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Curriculum"
        description="Courses, per-class course plans, and lecturer assignments."
      />
      <HubTabs basePath="/admin/curriculum" activeTab={activeTab} tabs={TABS} />
      {activeTab === "courses" && <CoursesPanel searchParams={params} />}
      {activeTab === "course-plans" && (
        <CoursePlansPanel classId={classId} semesterNumber={semesterNumber} />
      )}
      {activeTab === "assignments" && <AssignmentsPanel searchParams={params} />}
    </div>
  );
}
