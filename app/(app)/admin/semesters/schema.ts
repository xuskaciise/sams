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

export const openSemesterSchema = z.object({
  semesterId: z.string().min(1),
  classes: z.array(
    z.object({
      classId: z.string().min(1),
      advance: z.boolean(),
      // courseId -> lecturerId, for whichever semester-level plan the
      // class resolves into (current number, or +1 if advancing)
      lecturerByCourse: z.record(z.string(), z.string().min(1)),
    })
  ),
});

export type OpenSemesterInput = z.infer<typeof openSemesterSchema>;
