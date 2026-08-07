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
    // Manual, per-session, opt-in exception ONLY (see CLAUDE.md's "Period"
    // business rule) — true means this one session deliberately uses a
    // shift from the OTHER period than its class's own. The auto-generate
    // algorithm never sets this (it has no code path that could).
    // Deliberately required (not `.optional().default(false)`) — an
    // optional-with-default field's INPUT/OUTPUT types diverge, which
    // conflicts with react-hook-form's zodResolver generics in
    // timetable-client.tsx; every real caller already supplies it
    // explicitly (all form defaultValues/resets, build-timetable-client,
    // and every test fixture), so requiring it costs nothing.
    crossPeriodOverride: z.boolean(),
  })
  .refine((data) => timeToMinutes(data.endTime) > timeToMinutes(data.startTime), {
    message: "End time must be after start time",
    path: ["endTime"],
  });

export type TimetableSlotInput = z.infer<typeof timetableSlotSchema>;

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
