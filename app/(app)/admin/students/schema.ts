import { z } from "zod";

export const studentRegistrationSchema = z.object({
  studentNo: z.string().trim().min(1, "Student ID is required"),
  fullName: z.string().trim().min(1, "Full name is required"),
  gender: z.enum(["MALE", "FEMALE"]),
  classId: z.string().min(1, "Class is required"),
});

export type StudentRegistrationInput = z.infer<typeof studentRegistrationSchema>;
