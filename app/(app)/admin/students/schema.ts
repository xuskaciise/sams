import { z } from "zod";
import { PHONE_NUMBER_PATTERN } from "@/lib/whatsapp-notify";

// Optional — WhatsApp notifications (best-effort, unofficial, see
// lib/whatsapp-notify.ts) only ever send if this is set.
const phoneNumberField = z
  .string()
  .trim()
  .regex(PHONE_NUMBER_PATTERN, "Enter a valid phone number (e.g. +2526XXXXXXXX)")
  .optional()
  .or(z.literal(""));

// Optional real email — when present, used for automatic credential
// delivery + results-published emails (see lib/email-notify.ts). Same
// validate-if-provided / skip-if-blank pattern as phoneNumber. NOT the
// synthetic studentNo@students.sams.local login email.
export const emailField = z
  .string()
  .trim()
  .email("Enter a valid email address")
  .optional()
  .or(z.literal(""));

export const studentRegistrationSchema = z.object({
  studentNo: z.string().trim().min(1, "Student ID is required"),
  fullName: z.string().trim().min(1, "Full name is required"),
  gender: z.enum(["MALE", "FEMALE"]),
  classId: z.string().min(1, "Class is required"),
  phoneNumber: phoneNumberField,
  email: emailField,
});

export type StudentRegistrationInput = z.infer<typeof studentRegistrationSchema>;

export const studentPhoneNumberSchema = z.object({
  phoneNumber: phoneNumberField,
});

export type StudentPhoneNumberInput = z.infer<typeof studentPhoneNumberSchema>;
