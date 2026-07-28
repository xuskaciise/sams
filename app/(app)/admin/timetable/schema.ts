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

// Params for exportTimetable — mirrors exactly what the "Now" view's quick-
// select + advanced filters currently resolve to, so export always matches
// what's on screen at the moment it's clicked. `quick` is "now", "full", or
// a Shift id (the quick-select is dynamically generated from the Shift
// table, so there's no fixed enum to validate it against here — an
// unrecognized value falls back to "full", same as resolveNowView's own
// fallback).
export const timetableExportParamsSchema = z.object({
  quick: z.string().min(1),
  // Only meaningful when quick === "full" — "now" and a shift both resolve
  // their own day server-side from the current date.
  dayOfWeek: z.enum(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]).optional(),
  classId: z.string().optional(),
  lecturerId: z.string().optional(),
  roomId: z.string().optional(),
  campusId: z.string().optional(),
  semesterId: z.string().optional(),
});

export type TimetableExportParams = z.infer<typeof timetableExportParamsSchema>;
