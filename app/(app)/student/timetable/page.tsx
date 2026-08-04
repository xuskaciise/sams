import { getCurrentUser } from "@/lib/auth";
import { getMyTimetableForStudent } from "@/app/(app)/admin/timetable/queries";
import { PageHeader } from "@/components/layout/page-header";
import { WeeklyGrid, type WeeklyGridSlot } from "@/components/timetable/weekly-grid";

export default async function StudentTimetablePage() {
  const user = await getCurrentUser();
  const slots = await getMyTimetableForStudent(user!.id);

  const gridSlots: WeeklyGridSlot[] = slots.map((s) => ({
    id: s.id,
    dayOfWeek: s.dayOfWeek,
    startTime: s.startTime,
    endTime: s.endTime,
    courseName: s.assignment.course.name,
    className: s.assignment.class.name,
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
