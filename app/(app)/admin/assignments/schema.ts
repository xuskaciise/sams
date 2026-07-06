import { z } from "zod";

export const assignmentSchema = z.object({
  lecturerId: z.string().min(1, "Lecturer is required"),
  courseId: z.string().min(1, "Course is required"),
  classId: z.string().min(1, "Class is required"),
  semesterId: z.string().min(1, "Semester is required"),
});

export type AssignmentInput = z.infer<typeof assignmentSchema>;
