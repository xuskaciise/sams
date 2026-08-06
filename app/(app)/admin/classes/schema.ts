import { z } from "zod";

export const classSchema = z
  .object({
    programId: z.string().min(1, "Program is required"),
    // The batch's intake (cohort-starting) year — drives the auto-derived
    // batchCode (program.code + last 2 digits). Not free-typed batchCode
    // itself anymore; see composeClassData in actions.ts.
    intakeYear: z
      .number()
      .int()
      .min(1000, "Enter a 4-digit year")
      .max(9999, "Enter a 4-digit year")
      .optional(),
    section: z.string().trim().optional(),
    studyMode: z.enum(["FT", "PT"]).optional(),
    // FT-only — Morning ("Subax") or Afternoon ("Galab"). Required
    // whenever studyMode is FT (see the .refine below); never applicable
    // for PT, which has no period concept — composeClassData forces this
    // to null for a PT (or study-mode-less) class regardless of what's
    // submitted. Set explicitly per class row, never inherited from a
    // predecessor class at promotion.
    period: z.enum(["MORNING", "AFTERNOON"]).optional(),
    currentSemesterNumber: z.number().int().min(1).max(8).optional(),
    name: z.string().trim().optional(),
    // The class's single default room — optional at create/edit time (a
    // class can exist before its room is finalized); required only at
    // timetable build/generate time, validated there instead. See the
    // "Class Timetable" business rule in CLAUDE.md.
    roomId: z.string().optional(),
  })
  .refine(
    (data) =>
      (!!data.intakeYear && !!data.section && !!data.studyMode) ||
      (!!data.name && data.name.length > 0),
    {
      message:
        "Provide intake year, section, and study mode, or enter a name manually",
      path: ["name"],
    }
  )
  .refine((data) => data.studyMode !== "FT" || !!data.period, {
    message: "Period (Morning/Afternoon) is required for a full-time class",
    path: ["period"],
  });

export type ClassInput = z.infer<typeof classSchema>;

// Bulk period update — FT-only (see the "Period" business rule in
// CLAUDE.md). classIds is deliberately unbounded here; the server
// re-verifies every id is a real, currently FT class before writing —
// never trusts the client's own FT-only filtering.
export const bulkClassPeriodSchema = z.object({
  classIds: z.array(z.string().min(1)).min(1, "Select at least one class"),
  newPeriod: z.enum(["MORNING", "AFTERNOON"]),
});

export type BulkClassPeriodInput = z.infer<typeof bulkClassPeriodSchema>;
