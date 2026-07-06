import { z } from "zod";

export const departmentSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  code: z
    .string()
    .trim()
    .min(1, "Code is required")
    .transform((v) => v.toUpperCase()),
});

export type DepartmentInput = z.infer<typeof departmentSchema>;
