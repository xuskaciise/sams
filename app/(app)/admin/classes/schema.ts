import { z } from "zod";

export const classSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  programId: z.string().min(1, "Program is required"),
});

export type ClassInput = z.infer<typeof classSchema>;
