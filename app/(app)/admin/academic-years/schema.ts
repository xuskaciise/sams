import { z } from "zod";

export const academicYearSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required"),
    startDate: z.string().min(1, "Start date is required"),
    endDate: z.string().min(1, "End date is required"),
  })
  .refine((data) => new Date(data.endDate) > new Date(data.startDate), {
    message: "End date must be after start date",
    path: ["endDate"],
  });

export type AcademicYearInput = z.infer<typeof academicYearSchema>;
