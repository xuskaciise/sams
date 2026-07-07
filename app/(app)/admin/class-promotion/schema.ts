import { z } from "zod";

export const promoteClassSchema = z.object({
  sourceClassId: z.string().min(1, "Source class is required"),
  target: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("existing"), classId: z.string().min(1, "Target class is required") }),
    z.object({ mode: z.literal("new"), name: z.string().trim().min(1, "Class name is required") }),
  ]),
  studentIds: z.array(z.string().min(1)).min(1, "Select at least one student"),
});

export type PromoteClassInput = z.infer<typeof promoteClassSchema>;
