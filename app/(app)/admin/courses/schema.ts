import { z } from "zod";

export const courseSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  code: z
    .string()
    .trim()
    .min(1, "Code is required")
    .transform((v) => v.toUpperCase()),
});

export type CourseInput = z.infer<typeof courseSchema>;
