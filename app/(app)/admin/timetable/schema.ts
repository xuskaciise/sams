import { z } from "zod";
import { timeToMinutes } from "@/lib/timetable-conflicts";

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const timetableSlotSchema = z
  .object({
    lecturerCourseAssignmentId: z.string().min(1, "Course assignment is required"),
    dayOfWeek: z.enum(["MON", "TUE", "WED", "THU", "FRI", "SAT"]),
    startTime: z.string().regex(TIME_PATTERN, "Use 24-hour HH:MM"),
    endTime: z.string().regex(TIME_PATTERN, "Use 24-hour HH:MM"),
    roomId: z.string().min(1, "Room is required"),
  })
  .refine((data) => timeToMinutes(data.endTime) > timeToMinutes(data.startTime), {
    message: "End time must be after start time",
    path: ["endTime"],
  });

export type TimetableSlotInput = z.infer<typeof timetableSlotSchema>;
