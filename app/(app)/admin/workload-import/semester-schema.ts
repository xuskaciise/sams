import { z } from "zod";

// One OK row's shape after preview validation, for the per-semester-level
// workload import flow (see semester-actions.ts). Unlike the per-class
// flow's ClassWorkloadImportRow, this DOES carry classId/className/
// classCurrentSemesterNumber per row — one file can span every class at
// several selected semester levels at once, so each row must identify
// which class it belongs to. courseCode is carried through purely for
// display; matching used is courseId.
export const semesterWorkloadImportRowSchema = z.object({
  classId: z.string().min(1),
  className: z.string().min(1),
  classCurrentSemesterNumber: z.number().int().nullable(),
  courseId: z.string().min(1),
  courseCode: z.string().min(1),
  courseName: z.string().min(1),
  lecturerId: z.string().min(1),
  lecturerName: z.string().min(1),
  creditHours: z.number().positive(),
});

export type SemesterWorkloadImportRow = z.infer<typeof semesterWorkloadImportRowSchema>;

export const confirmSemesterWorkloadImportSchema = z.array(semesterWorkloadImportRowSchema);
