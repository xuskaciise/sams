import { z } from "zod";

export const userFormSchema = z
  .object({
    role: z.enum(["ADMIN", "DEAN", "LECTURER", "STUDENT"]),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .min(1, "Email is required")
      .email("Enter a valid email"),
    fullName: z.string().trim().min(1, "Full name is required"),
    staffNo: z.string().trim().optional(),
    title: z.string().trim().optional(),
    studentNo: z.string().trim().optional(),
    classId: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.role === "LECTURER" && !data.staffNo?.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "Staff number is required",
        path: ["staffNo"],
      });
    }
    if (data.role === "STUDENT") {
      if (!data.studentNo?.trim()) {
        ctx.addIssue({
          code: "custom",
          message: "Student number is required",
          path: ["studentNo"],
        });
      }
      if (!data.classId) {
        ctx.addIssue({
          code: "custom",
          message: "Class is required",
          path: ["classId"],
        });
      }
    }
  });

export type UserFormInput = z.infer<typeof userFormSchema>;
