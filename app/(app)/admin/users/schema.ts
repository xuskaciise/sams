import { z } from "zod";

export const userFormSchema = z
  .object({
    // A role NAME from the roles table (validated server-side — must
    // exist and must not be STUDENT). Custom roles are allowed here.
    role: z.string().trim().min(1, "Role is required"),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .min(1, "Email is required")
      .email("Enter a valid email"),
    fullName: z.string().trim().min(1, "Full name is required"),
    staffNo: z.string().trim().optional(),
    title: z.string().trim().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.role === "LECTURER" && !data.staffNo?.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "Staff number is required",
        path: ["staffNo"],
      });
    }
  });

export type UserFormInput = z.infer<typeof userFormSchema>;
