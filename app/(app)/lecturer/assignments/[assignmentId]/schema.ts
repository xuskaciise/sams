import { z } from "zod";

export const assessmentSchema = z.object({
  title: z.string().trim().min(1, "Title is required"),
  assessmentTypeId: z.string().min(1, "Type is required"),
  maximumMarks: z
    .number()
    .positive("Must be greater than 0")
    .max(999.99, "Must be 999.99 or less"),
  mode: z.enum(["INDIVIDUAL", "GROUP"]),
});

export type AssessmentInput = z.infer<typeof assessmentSchema>;
