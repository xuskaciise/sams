import { z } from "zod";

// title is optional at the schema level because LEAVE_NOTICE entries never
// need one typed — the server derives it from the picked lecturer's name
// (see actions.ts). PROBLEM/NOTE entries require it, enforced below.
export const dailyLogEntrySchema = z
  .object({
    departmentId: z.string().min(1, "Faculty is required"),
    type: z.enum(["LEAVE_NOTICE", "PROBLEM", "NOTE"]),
    relatedLecturerId: z.string().optional(),
    // Optional, NOTE/PROBLEM only — not every note/problem is about a
    // specific student. LEAVE_NOTICE never sets this (relatedLecturerId
    // is its reference instead).
    relatedStudentId: z.string().optional(),
    title: z.string().trim().optional(),
    description: z.string().trim().optional(),
    entryDate: z.string().min(1, "Date is required"),
  })
  .refine((data) => data.type !== "LEAVE_NOTICE" || !!data.relatedLecturerId, {
    message: "Pick the lecturer this leave notice is for",
    path: ["relatedLecturerId"],
  })
  .refine((data) => data.type === "LEAVE_NOTICE" || !!data.title, {
    message: "Title is required",
    path: ["title"],
  });

export type DailyLogEntryInput = z.infer<typeof dailyLogEntrySchema>;
