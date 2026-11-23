import { z } from "zod";

// One row per COURSE the office manually checked off for this student —
// ALL system courses are offered (see queries.ts's getAllCourseOptions),
// not just ones the student is known to be enrolled in. There is
// deliberately NO examType here: it is always derived server-side from
// the selected period's phase (recordMissedExamsBulk), never client input.
// CHEATING/EMERGENCY still exist in the DB enum (legacy rows) but are
// never accepted for new registrations or edits.
export const reasonTypeSchema = z.enum(["FINANCE", "ILLNESS", "LATE", "OTHER"]);

export const missedExamGridRowSchema = z.object({
  courseId: z.string().min(1),
  reasonType: reasonTypeSchema,
  reasonNote: z.string().trim().max(1000).optional(),
});

// No classId, no enrollmentId — the student is looked up directly by
// student_no and courses are picked manually from the full system list,
// so there's nothing enrollment-derived left to carry.
export const missedExamBulkSchema = z.object({
  specialExamPeriodId: z.string().min(1, "Special Exam Period is required"),
  studentId: z.string().min(1, "Student is required"),
  rows: z.array(missedExamGridRowSchema).min(1, "Select at least one exam to record"),
});

export type NewReasonType = z.infer<typeof reasonTypeSchema>;
export type MissedExamGridRowInput = z.infer<typeof missedExamGridRowSchema>;
export type MissedExamBulkInput = z.infer<typeof missedExamBulkSchema>;

// Editing one already-recorded MissedExamRecord — exam.records.manage
// (the same key that gates recording one in the first place). Only
// reasonType/reasonNote are editable; who it's for/which course/which
// period never change here (that would just be a new record), and the
// exam type is fixed by the period's phase.
export const missedExamUpdateSchema = z.object({
  reasonType: reasonTypeSchema,
  reasonNote: z.string().trim().max(1000).optional(),
});

export type MissedExamUpdateInput = z.infer<typeof missedExamUpdateSchema>;
