import { z } from "zod";

export const groupNameSchema = z.object({
  name: z.string().trim().min(1, "Group name is required"),
});

export type GroupNameInput = z.infer<typeof groupNameSchema>;
