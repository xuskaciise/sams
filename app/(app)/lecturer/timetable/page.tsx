import { redirect } from "next/navigation";

// The standalone Lecturer timetable page was removed — timetable
// building/management is Admin/Dean-only, and a lecturer's own daily
// view is the "Today's Schedule" widget on their dashboard
// (getMyTodayScheduleAsLecturer in today-schedule-actions.ts, unchanged).
// This route stays only to redirect any stale bookmark; same
// redirect("/") pattern as the workload-import self-gate.
export default async function LecturerTimetablePage() {
  redirect("/");
}
