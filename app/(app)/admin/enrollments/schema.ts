import { z } from "zod";

export const enrollmentSchema = z.object({
  studentId: z.string().min(1, "Student is required"),
  courseId: z.string().min(1, "Course is required"),
  semesterId: z.string().min(1, "Semester is required"),
});

export type EnrollmentInput = z.infer<typeof enrollmentSchema>;

export const transferSchema = z.object({
  newClassId: z.string().min(1, "Class is required"),
});

export type TransferInput = z.infer<typeof transferSchema>;
