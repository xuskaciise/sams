import { z } from "zod";

export const programSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  code: z
    .string()
    .trim()
    .min(1, "Code is required")
    .transform((v) => v.toUpperCase()),
  departmentId: z.string().min(1, "Department is required"),
});

export type ProgramInput = z.infer<typeof programSchema>;
