import { z } from "zod";

const dayOfWeekSchema = z.enum(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]);

export const previewBatchRowSchema = z.object({
  assignmentId: z.string().min(1),
  shiftOverrideIds: z.array(z.string().min(1)).optional(),
});

export const previewBatchSchema = z.object({
  semesterId: z.string().min(1),
  // Class.currentSemesterNumber level being processed — the sequential
  // odd-number-at-a-time rule (see lib/auto-timetable.ts) is enforced by
  // the client only ever offering the next odd number; the server just
  // re-validates that every submitted assignment's class is genuinely at
  // this level (defends against a tampered value, not a workflow gate).
  semesterNumber: z.number().int().positive(),
  assignments: z.array(previewBatchRowSchema).min(1),
});

export type PreviewBatchInput = z.infer<typeof previewBatchSchema>;

const scheduledSessionSchema = z.object({
  assignmentId: z.string().min(1),
  classId: z.string().min(1),
  roomId: z.string().min(1),
  dayOfWeek: dayOfWeekSchema,
  startTime: z.string().min(1),
  endTime: z.string().min(1),
  // Manual, per-session, opt-in exception ONLY — see CLAUDE.md's "Period"
  // business rule. Always false for anything the algorithm itself
  // scheduled; true only when the admin/dean manually placed this session
  // on a cross-period shift in the preview overview before confirming.
  // Required (not defaulted) — CommitSession (lib/auto-timetable-preview-
  // state.ts) already always supplies it, so there's no caller that needs
  // the default.
  crossPeriodOverride: z.boolean(),
});

export const confirmBatchSchema = z.object({
  semesterId: z.string().min(1),
  semesterNumber: z.number().int().positive(),
  sessions: z.array(scheduledSessionSchema).min(1),
});

export type ConfirmBatchInput = z.infer<typeof confirmBatchSchema>;
