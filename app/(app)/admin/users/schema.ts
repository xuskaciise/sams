import { z } from "zod";
import { PHONE_NUMBER_PATTERN } from "@/lib/whatsapp-notify";

export const userFormSchema = z
  .object({
    // A role NAME from the roles table (validated server-side — must
    // exist and must not be STUDENT). Custom roles are allowed here.
    role: z.string().trim().min(1, "Role is required"),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .min(1, "Email is required")
      .email("Enter a valid email"),
    fullName: z.string().trim().min(1, "Full name is required"),
    staffNo: z.string().trim().optional(),
    title: z.string().trim().optional(),
    // LECTURER-only, optional — WhatsApp notifications (best-effort,
    // unofficial, see lib/whatsapp-notify.ts) only ever send if set.
    phoneNumber: z
      .string()
      .trim()
      .regex(PHONE_NUMBER_PATTERN, "Enter a valid phone number (e.g. +2526XXXXXXXX)")
      .optional()
      .or(z.literal("")),
  })
  .superRefine((data, ctx) => {
    if (data.role === "LECTURER" && !data.staffNo?.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "Staff number is required",
        path: ["staffNo"],
      });
    }
  });

export type UserFormInput = z.infer<typeof userFormSchema>;
