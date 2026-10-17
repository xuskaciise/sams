import { z } from "zod";

export const assignmentSchema = z.object({
  lecturerId: z.string().min(1, "Lecturer is required"),
  courseId: z.string().min(1, "Course is required"),
  classId: z.string().min(1, "Class is required"),
  semesterId: z.string().min(1, "Semester is required"),
});

export type AssignmentInput = z.infer<typeof assignmentSchema>;

// Bulk assign (mid-semester / ad-hoc): rows always normalize to this flat
// shape regardless of which direction the admin filled them in from
// (lecturer-first: fixed lecturer, rows of course+class; class-first:
// fixed class, rows of course+lecturer) — the server only ever sees a
// flat candidate list.
export const bulkAssignmentRowSchema = z.object({
  lecturerId: z.string().min(1, "Lecturer is required"),
  courseId: z.string().min(1, "Course is required"),
  classId: z.string().min(1, "Class is required"),
});

export const bulkAssignmentSchema = z.object({
  semesterId: z.string().min(1, "Semester is required"),
  rows: z.array(bulkAssignmentRowSchema).min(1, "Add at least one row"),
});

export type BulkAssignmentRow = z.infer<typeof bulkAssignmentRowSchema>;
export type BulkAssignmentInput = z.infer<typeof bulkAssignmentSchema>;

// Excel export: the same URL filters the on-screen table uses. Every field
// is optional — an absent semesterId means "the active semester", exactly
// like the table (see query.ts).
export const exportAssignmentsSchema = z.object({
  classId: z.string().max(100).optional(),
  courseId: z.string().max(100).optional(),
  lecturerId: z.string().max(100).optional(),
  semesterId: z.string().max(100).optional(),
  q: z.string().max(200).optional(),
});

export type ExportAssignmentsInput = z.infer<typeof exportAssignmentsSchema>;
