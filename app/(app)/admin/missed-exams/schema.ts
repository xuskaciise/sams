import { z } from "zod";

// A student's "course" here is really one of their own
// StudentCourseEnrollments, resolved server-side (both in the picker
// action and again on submit) into the matching LecturerCourseAssignment
// — see queries.ts's getStudentExamOptions. assignmentId is the real
// tie to course+class+semester; courseId is carried alongside purely so
// the client doesn't need a second round trip to label the picked
// option, and is re-derived from the assignment server-side on submit
// (never trusted from the client) — see actions.ts.
export const missedExamRecordSchema = z.object({
  studentId: z.string().min(1, "Student is required"),
  assignmentId: z.string().min(1, "Course is required"),
  examType: z.enum(["MIDTERM", "FINAL", "BOTH"]),
  reasonType: z.enum(["ILLNESS", "CHEATING", "EMERGENCY", "OTHER"]),
  reasonNote: z.string().trim().max(1000).optional(),
});

export type MissedExamRecordInput = z.infer<typeof missedExamRecordSchema>;
