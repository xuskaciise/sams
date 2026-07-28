import { z } from "zod";

export const campusSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  address: z.string().trim().optional(),
});

export type CampusInput = z.infer<typeof campusSchema>;
