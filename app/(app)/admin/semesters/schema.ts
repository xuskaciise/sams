import { z } from "zod";

export const semesterSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required"),
    academicYearId: z.string().min(1, "Academic year is required"),
    startDate: z.string().min(1, "Start date is required"),
    endDate: z.string().min(1, "End date is required"),
  })
  .refine((data) => new Date(data.endDate) > new Date(data.startDate), {
    message: "End date must be after start date",
    path: ["endDate"],
  });

export type SemesterInput = z.infer<typeof semesterSchema>;
