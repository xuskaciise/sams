import { redirect } from "next/navigation";
import { getCurrentUser, getSessionContext } from "@/lib/auth";
import { getMyTimetableForStudent } from "@/app/(app)/admin/timetable/queries";
import { PageHeader } from "@/components/layout/page-header";
import { WeeklyGrid, type WeeklyGridSlot } from "@/components/timetable/weekly-grid";
import { formatClassLabel } from "@/lib/class-label";

export default async function StudentTimetablePage() {
  // Self-gate on the student-portal signature key (defense in depth on
  // top of student/layout.tsx) — timetable.view.own alone, held by
  // LECTURER too, must not reach this student route. Same redirect-self-
  // gate pattern as WorkloadImportPanel / WhatsAppPanel.
  const ctx = await getSessionContext();
  if (!ctx?.permissions.has("results.view.own")) {
    redirect("/");
  }

  const user = await getCurrentUser();
  const slots = await getMyTimetableForStudent(user!.id);

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
      <PageHeader title="My Timetable" description="Your weekly class schedule, read-only." />
      <WeeklyGrid slots={gridSlots} />
    </div>
  );
}
