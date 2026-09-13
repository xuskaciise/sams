import { z } from "zod";

export const specialExamPeriodSchema = z.object({
  academicYearId: z.string().min(1, "Academic year is required"),
  semesterId: z.string().min(1, "Semester is required"),
});

export type SpecialExamPeriodInput = z.infer<typeof specialExamPeriodSchema>;
