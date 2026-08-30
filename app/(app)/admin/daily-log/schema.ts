import { z } from "zod";

// "Who this is about" is the SAME optional lecturer-or-student choice for
// all three types now, never both at once — only how it's enforced
// differs: LEAVE_NOTICE requires exactly one (it doesn't make sense
// without a subject), PROBLEM/NOTE allow neither. title is optional at
// the schema level because LEAVE_NOTICE never needs one typed — the
// server derives it from whichever of lecturer/student was picked (see
// actions.ts). PROBLEM/NOTE entries require it, enforced below.
export const dailyLogEntrySchema = z
  .object({
    departmentId: z.string().min(1, "Faculty is required"),
    type: z.enum(["LEAVE_NOTICE", "PROBLEM", "NOTE"]),
    relatedLecturerId: z.string().optional(),
    relatedStudentId: z.string().optional(),
    title: z.string().trim().optional(),
    description: z.string().trim().optional(),
    entryDate: z.string().min(1, "Date is required"),
    // TimetableSlot ids the leave notice covers (LEAVE_NOTICE only —
    // ignored for NOTE/PROBLEM). Plain `.optional()`, never
    // `.optional().default([])`, which breaks react-hook-form's
    // zodResolver generics; the form always supplies `[]`, the server
    // coalesces a missing value.
    sessionIds: z.array(z.string()).optional(),
  })
  .refine(
    (data) =>
      data.type !== "LEAVE_NOTICE" ||
      !!data.relatedLecturerId ||
      !!data.relatedStudentId,
    {
      message: "Pick who this leave notice is about",
      path: ["relatedLecturerId"],
    }
  )
  .refine((data) => !(data.relatedLecturerId && data.relatedStudentId), {
    message: "Pick either a lecturer or a student, not both",
    path: ["relatedStudentId"],
  })
  .refine((data) => data.type === "LEAVE_NOTICE" || !!data.title, {
    message: "Title is required",
    path: ["title"],
  });

export type DailyLogEntryInput = z.infer<typeof dailyLogEntrySchema>;
