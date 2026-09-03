"use server";

import { requirePermission } from "@/lib/auth";
import { formatClassLabel } from "@/lib/class-label";
import {
  buildTodaySchedule,
  type TodaySchedule,
  type TodayScheduleInput,
} from "@/lib/timetable-now";
import {
  getMyTimetableForLecturer,
  getMyTimetableForStudent,
} from "@/app/(app)/admin/timetable/queries";

// Both my-timetable queries use the identical `slotInclude`, so one row
// type covers both.
type MySlot = Awaited<ReturnType<typeof getMyTimetableForLecturer>>[number];

function toInput(s: MySlot): TodayScheduleInput {
  return {
    id: s.id,
    dayOfWeek: s.dayOfWeek,
    startTime: s.startTime,
    endTime: s.endTime,
    courseName: s.assignment.course.name,
    className: formatClassLabel(s.assignment.class),
    // room is a required FK on TimetableSlot — always present.
    roomLabel: `${s.room.name} — ${s.room.campus.name}`,
  };
}

// The Lecturer dashboard "Today's Schedule" widget's data + its 60s
// live-refresh call. Scoped through the assignment's lecturer.userId (the
// query IS the ownership check — same idiom as getMyTimetableForLecturer,
// which this reuses). Gated on timetable.view.own, the same read
// permission the lecturer's own /lecturer/timetable page requires.
export async function getMyTodayScheduleAsLecturer(): Promise<TodaySchedule> {
  const user = await requirePermission("timetable.view.own");
  const slots = await getMyTimetableForLecturer(user.id);
  return buildTodaySchedule(slots.map(toInput), new Date());
}

// Student counterpart — scoped through the student's own ACTIVE
// enrollments (see getMyTimetableForStudent). Same permission.
export async function getMyTodayScheduleAsStudent(): Promise<TodaySchedule> {
  const user = await requirePermission("timetable.view.own");
  const slots = await getMyTimetableForStudent(user.id);
  return buildTodaySchedule(slots.map(toInput), new Date());
}
