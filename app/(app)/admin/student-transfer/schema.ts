import { z } from "zod";

export const studentTransferPreviewSchema = z.object({
  studentId: z.string().min(1, "Pick a student"),
  targetClassId: z.string().min(1, "Pick a target class"),
});

export const studentTransferSchema = studentTransferPreviewSchema.extend({
  // Required to be true when the target class has no course assignments in
  // the active semester (nothing would be enrolled) — the server rejects
  // the transfer otherwise, so the warning can't be skipped client-side.
  acknowledgeNoCourses: z.boolean(),
});

export type StudentTransferPreviewInput = z.infer<typeof studentTransferPreviewSchema>;
export type StudentTransferInput = z.infer<typeof studentTransferSchema>;
