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

// The "Lecturer availability" wizard step's save payload — one entry per
// DISTINCT lecturer in the batch being generated, re-entered/confirmed
// fresh each generation cycle rather than a permanent Lecturer Registration
// field (see CLAUDE.md's "Lecturer availableDays" business rule). Day+shift
// granularity: `shiftIds` empty means "every shift this day is allowed"
// (day-level only); non-empty means ONLY those shifts on that day.
const lecturerAvailabilityDayInputSchema = z.object({
  dayOfWeek: dayOfWeekSchema,
  shiftIds: z.array(z.string().min(1)),
});

export const lecturerAvailabilityUpdateSchema = z.object({
  lecturerId: z.string().min(1),
  // One entry per day this lecturer is available on at all — a day with
  // no entry here is simply not available. Empty array overall = fully
  // unrestricted (the default).
  availability: z.array(lecturerAvailabilityDayInputSchema),
});

export const lecturerAvailabilityUpdatesSchema = z.array(lecturerAvailabilityUpdateSchema);

export type LecturerAvailabilityUpdateInput = z.infer<typeof lecturerAvailabilityUpdateSchema>;
