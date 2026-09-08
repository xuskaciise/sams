import { redirect } from "next/navigation";
import { getCurrentUser, getSessionContext } from "@/lib/auth";
import { getMyTimetableForLecturer } from "@/app/(app)/admin/timetable/queries";
import { PageHeader } from "@/components/layout/page-header";
import { WeeklyGrid, type WeeklyGridSlot } from "@/components/timetable/weekly-grid";
import { formatClassLabel } from "@/lib/class-label";

// Lecturer's own read-only weekly schedule — a WeeklyGrid with no
// edit/delete handlers, so no per-slot menu (building/managing timetables
// stays Admin/Dean-only). Coexists with the dashboard "Today's Schedule"
// widget (getMyTodayScheduleAsLecturer): this is the full week.
//
// Self-gate on the LECTURER-signature key (defense in depth on top of
// lecturer/layout.tsx): timetable.view.own alone, held by STUDENT too,
// must not reach this lecturer route. Same redirect-self-gate pattern as
// the student /student/timetable page and WorkloadImportPanel.
export default async function LecturerTimetablePage() {
  const ctx = await getSessionContext();
  if (!ctx?.permissions.has("assessment.view.own")) {
    redirect("/");
  }

  const user = await getCurrentUser();
  const slots = await getMyTimetableForLecturer(user!.id);

  const gridSlots: WeeklyGridSlot[] = slots.map((s) => ({
    id: s.id,
    dayOfWeek: s.dayOfWeek,
    startTime: s.startTime,
    endTime: s.endTime,
    courseName: s.assignment.course.name,
    className: formatClassLabel(s.assignment.class),
    lecturerName: s.assignment.lecturer.fullName,
    roomName: s.room.name,
    studyMode: s.assignment.class.studyMode,
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="My Schedule" description="Your weekly teaching schedule, read-only." />
      <WeeklyGrid slots={gridSlots} />
    </div>
  );
}
