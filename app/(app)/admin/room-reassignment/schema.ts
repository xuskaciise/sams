import { z } from "zod";

// One row per class the admin/dean actually changed a room for. The
// server re-validates every classId against the caller's own scope and
// recomputes the whole plan — the client's list is never trusted.
export const roomReassignmentSchema = z.object({
  rows: z
    .array(
      z.object({
        classId: z.string().min(1),
        newRoomId: z.string().min(1),
      })
    )
    .min(1, "Change at least one class's room"),
});

export type RoomReassignmentInput = z.infer<typeof roomReassignmentSchema>;
