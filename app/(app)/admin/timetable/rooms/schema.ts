import { z } from "zod";

export const roomSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  capacity: z.number().int().positive("Capacity must be a positive number").optional(),
});

export type RoomInput = z.infer<typeof roomSchema>;
