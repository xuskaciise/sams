import { z } from "zod";

// eventKey is required only for AUTOMATIC (must be a registered,
// not-yet-templated hook key — checked against the code registry
// server-side in createWhatsAppTemplate, never trusted here); name is
// required only for MANUAL (AUTOMATIC falls back to the registry's own
// label when left blank). Both branches are enforced via .refine rather
// than a discriminated union, matching this app's existing pattern for
// "which fields are required depends on a picked type" forms (e.g. the
// Daily Log related-person field).
export const createEventTypeSchema = z
  .object({
    triggerKind: z.enum(["AUTOMATIC", "MANUAL"]),
    eventKey: z.string().trim().min(1).optional(),
    name: z.string().trim().max(120).optional(),
    description: z.string().trim().max(500).optional(),
    templateText: z.string().trim().min(1, "Template text is required"),
  })
  .refine((data) => data.triggerKind !== "AUTOMATIC" || !!data.eventKey, {
    message: "Pick which existing hook this automatic type is for.",
    path: ["eventKey"],
  })
  .refine((data) => data.triggerKind !== "MANUAL" || !!data.name?.trim(), {
    message: "Name is required for a manual notification type.",
    path: ["name"],
  });

export type CreateEventTypeInput = z.input<typeof createEventTypeSchema>;
