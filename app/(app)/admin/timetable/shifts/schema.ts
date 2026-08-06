import { z } from "zod";
import { timeToMinutes } from "@/lib/timetable-conflicts";

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const shiftSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required"),
    studyMode: z.enum(["FT", "PT"]),
    // Required for FT shifts (Morning "Subax" / Afternoon "Galab" — e.g.
    // "Subax 1aad" = FT/Morning, "Galab 1aad" = FT/Afternoon); never
    // applicable for PT, which has no period split at all — see the
    // .transform below, which forces this to null for a PT shift
    // regardless of what's submitted.
    period: z.enum(["MORNING", "AFTERNOON"]).optional(),
    startTime: z.string().regex(TIME_PATTERN, "Use 24-hour HH:MM"),
    endTime: z.string().regex(TIME_PATTERN, "Use 24-hour HH:MM"),
  })
  .refine((data) => timeToMinutes(data.endTime) > timeToMinutes(data.startTime), {
    message: "End time must be after start time",
    path: ["endTime"],
  })
  .refine((data) => data.studyMode !== "FT" || !!data.period, {
    message: "Period (Morning/Afternoon) is required for an FT shift",
    path: ["period"],
  });

export type ShiftInput = z.infer<typeof shiftSchema>;
