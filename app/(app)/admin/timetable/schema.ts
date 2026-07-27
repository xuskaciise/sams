import { z } from "zod";
import { timeToMinutes } from "@/lib/timetable-conflicts";

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const timetableSlotSchema = z
  .object({
    lecturerCourseAssignmentId: z.string().min(1, "Course assignment is required"),
    dayOfWeek: z.enum(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]),
    startTime: z.string().regex(TIME_PATTERN, "Use 24-hour HH:MM"),
    endTime: z.string().regex(TIME_PATTERN, "Use 24-hour HH:MM"),
    roomId: z.string().min(1, "Room is required"),
  })
  .refine((data) => timeToMinutes(data.endTime) > timeToMinutes(data.startTime), {
    message: "End time must be after start time",
    path: ["endTime"],
  });

export type TimetableSlotInput = z.infer<typeof timetableSlotSchema>;

// One row of a "Build timetable" whole-week submission. `key` is a
// client-generated row id (not persisted) used purely to correlate a
// returned conflict/violation back to the UI row that caused it.
export const buildTimetableSessionSchema = z
  .object({
    key: z.string().min(1),
    lecturerCourseAssignmentId: z.string().min(1, "Course assignment is required"),
    dayOfWeek: z.enum(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]),
    startTime: z.string().regex(TIME_PATTERN, "Use 24-hour HH:MM"),
    endTime: z.string().regex(TIME_PATTERN, "Use 24-hour HH:MM"),
    roomId: z.string().min(1, "Room is required"),
  })
  .refine((data) => timeToMinutes(data.endTime) > timeToMinutes(data.startTime), {
    message: "End time must be after start time",
    path: ["endTime"],
  });

export const buildTimetableSchema = z.object({
  classId: z.string().min(1, "Class is required"),
  semesterId: z.string().min(1, "Semester is required"),
  sessions: z.array(buildTimetableSessionSchema).min(1, "Add at least one session"),
});

export type BuildTimetableSessionInput = z.infer<typeof buildTimetableSessionSchema>;
export type BuildTimetableInput = z.infer<typeof buildTimetableSchema>;
