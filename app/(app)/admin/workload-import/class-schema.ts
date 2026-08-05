import { z } from "zod";

// One OK row's shape after preview validation, for the per-class workload
// import flow (see class-actions.ts). Deliberately narrower than
// WorkloadImportRow (schema.ts) — semester/program/class are no longer
// per-row, since the whole file targets exactly ONE pre-selected class;
// courseCode is carried through purely for display in the confirm/success
// table, matching used is courseId.
export const classWorkloadImportRowSchema = z.object({
  courseId: z.string().min(1),
  courseCode: z.string().min(1),
  courseName: z.string().min(1),
  lecturerId: z.string().min(1),
  lecturerName: z.string().min(1),
  creditHours: z.number().positive(),
});

export type ClassWorkloadImportRow = z.infer<typeof classWorkloadImportRowSchema>;

export const confirmClassWorkloadImportSchema = z.array(classWorkloadImportRowSchema);
