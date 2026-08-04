import { z } from "zod";

// One OK row's shape after preview validation — sent back verbatim to
// confirmWorkloadImport, and (for created rows) forwarded into the
// auto-timetable generator if the admin/dean chooses "Continue".
export const workloadImportRowSchema = z.object({
  semesterId: z.string().min(1),
  semesterLabel: z.string().min(1),
  classId: z.string().min(1),
  className: z.string().min(1),
  classCurrentSemesterNumber: z.number().int().nullable(),
  studyMode: z.enum(["FT", "PT"]).nullable(),
  courseId: z.string().min(1),
  courseName: z.string().min(1),
  lecturerId: z.string().min(1),
  lecturerName: z.string().min(1),
  creditHours: z.number().positive(),
});

export type WorkloadImportRow = z.infer<typeof workloadImportRowSchema>;

export const confirmWorkloadImportSchema = z.array(workloadImportRowSchema);
