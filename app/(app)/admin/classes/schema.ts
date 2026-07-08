import { z } from "zod";

export const classSchema = z
  .object({
    programId: z.string().min(1, "Program is required"),
    batchCode: z.string().trim().optional(),
    section: z.string().trim().optional(),
    studyMode: z.enum(["FT", "PT"]).optional(),
    currentSemesterNumber: z.number().int().min(1).max(8).optional(),
    name: z.string().trim().optional(),
  })
  .refine(
    (data) =>
      (!!data.batchCode && !!data.section && !!data.studyMode) ||
      (!!data.name && data.name.length > 0),
    {
      message:
        "Provide batch code, section, and study mode, or enter a name manually",
      path: ["name"],
    }
  );

export type ClassInput = z.infer<typeof classSchema>;
