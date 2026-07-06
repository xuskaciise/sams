import { z } from "zod";

export const resultSchema = z.object({
  enrollmentId: z.string().min(1),
  mark: z.number().nullable(),
  attendanceStatus: z.enum(["PRESENT", "ABSENT", "EXEMPT"]),
  currentUpdatedAt: z.string().nullable(),
});

export type ResultInput = z.infer<typeof resultSchema>;

export const correctionSchema = z.object({
  newMark: z.number(),
  reason: z.string().trim().min(1, "A reason is required"),
});

export type CorrectionInput = z.infer<typeof correctionSchema>;

export const applyGroupMarkSchema = z.object({
  mark: z.number(),
});

export type ApplyGroupMarkInput = z.infer<typeof applyGroupMarkSchema>;
