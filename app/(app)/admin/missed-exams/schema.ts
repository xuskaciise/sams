import { z } from "zod";

// One row per (student, course) the bulk grid checked off. examType is
// derived client-side from the Midterm/Final/All checkboxes before
// submit (BOTH when both are checked) — see missed-exams-client.tsx.
export const missedExamGridRowSchema = z.object({
  enrollmentId: z.string().min(1),
  studentId: z.string().min(1),
  assignmentId: z.string().min(1),
  examType: z.enum(["MIDTERM", "FINAL", "BOTH"]),
  reasonType: z.enum(["ILLNESS", "CHEATING", "EMERGENCY", "OTHER"]),
  reasonNote: z.string().trim().max(1000).optional(),
});

export const missedExamBulkSchema = z.object({
  specialExamPeriodId: z.string().min(1, "Special Exam Period is required"),
  classId: z.string().min(1, "Class is required"),
  rows: z.array(missedExamGridRowSchema).min(1, "Select at least one exam to record"),
});

export type MissedExamGridRowInput = z.infer<typeof missedExamGridRowSchema>;
export type MissedExamBulkInput = z.infer<typeof missedExamBulkSchema>;

// Editing one already-recorded MissedExamRecord — exam.records.manage
// (the same key that gates recording one in the first place). Only
// examType/reasonType/reasonNote are editable; who it's for/which
// course/which period never change here (that would just be a new
// record).
export const missedExamUpdateSchema = z.object({
  examType: z.enum(["MIDTERM", "FINAL", "BOTH"]),
  reasonType: z.enum(["ILLNESS", "CHEATING", "EMERGENCY", "OTHER"]),
  reasonNote: z.string().trim().max(1000).optional(),
});

export type MissedExamUpdateInput = z.infer<typeof missedExamUpdateSchema>;
