import { z } from "zod";

export const resultSchema = z.object({
  enrollmentId: z.string().min(1),
  mark: z.number().nullable(),
  attendanceStatus: z.enum(["PRESENT", "ABSENT", "EXEMPT"]),
  currentUpdatedAt: z.string().nullable(),
  // Reference only (snapshot model) — set when this save came from a
  // group's "Different marks" panel, null for individual/ungrouped saves.
  groupId: z.string().nullable().optional(),
});

export type ResultInput = z.infer<typeof resultSchema>;

// Late-add: a NEW result row for a student who is actively enrolled but has
// no result row yet on an already-PUBLISHED assessment (late enrollment,
// class transfer, a repeater added after the original publish). Distinct
// from resultSchema only in that there's no currentUpdatedAt to check —
// there's nothing to optimistically lock against, since the row doesn't
// exist yet.
export const lateResultSchema = z.object({
  enrollmentId: z.string().min(1),
  mark: z.number().nullable(),
  attendanceStatus: z.enum(["PRESENT", "ABSENT", "EXEMPT"]),
  groupId: z.string().nullable().optional(),
});

export type LateResultInput = z.infer<typeof lateResultSchema>;

export const correctionSchema = z.object({
  newMark: z.number(),
  reason: z.string().trim().min(1, "A reason is required"),
});

export type CorrectionInput = z.infer<typeof correctionSchema>;

export const applyGroupMarkSchema = z.object({
  mark: z.number(),
  // Attendance stays per-member even under "same mark" — a member marked
  // ABSENT/EXEMPT gets a null mark regardless of the shared value.
  attendanceByStudentId: z.record(
    z.string(),
    z.enum(["PRESENT", "ABSENT", "EXEMPT"])
  ),
});

export type ApplyGroupMarkInput = z.infer<typeof applyGroupMarkSchema>;
