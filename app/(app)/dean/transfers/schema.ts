import { z } from "zod";

export const transferOwnershipSchema = z.object({
  newLecturerId: z.string().min(1, "New lecturer is required"),
  reason: z.string().trim().min(1, "A reason is required"),
});

export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>;
