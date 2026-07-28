import { z } from "zod";

export const roomSchema = z.object({
  campusId: z.string().min(1, "Campus is required"),
  name: z.string().trim().min(1, "Name is required"),
  capacity: z.number().int().positive("Capacity must be a positive number").optional(),
});

export type RoomInput = z.infer<typeof roomSchema>;

// One row of a bulk add — shared shape for both the pasted-list and the
// generated-range entry paths, so preview/confirm never need to know
// which one produced a given row.
export const bulkRoomRowSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  capacity: z.number().int().positive("Capacity must be a positive number").optional(),
});

export const bulkRoomRowsSchema = z
  .array(bulkRoomRowSchema)
  .min(1, "Add at least one room")
  .max(500, "Too many rooms at once (max 500)");

export type BulkRoomRow = z.infer<typeof bulkRoomRowSchema>;
