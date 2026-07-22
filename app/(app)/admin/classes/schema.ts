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
    currentSemesterNumber: z.number().int().min(1).max(8).optional(),
    name: z.string().trim().optional(),
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
  );

export type ClassInput = z.infer<typeof classSchema>;
