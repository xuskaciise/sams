import { z } from "zod";
import { PHONE_NUMBER_PATTERN } from "@/lib/whatsapp-notify";

// OPTIONAL — see Lecturer.availableDays in schema.prisma. Empty array
// means unrestricted, exactly today's behavior; a non-empty array is a
// HARD scheduling constraint everywhere a session gets placed for this
// lecturer (see lib/auto-timetable.ts). Deliberately a plain required
// z.array(...), not `.optional().default([])` — an optional-with-default
// field's diverging Zod input/output types break react-hook-form's
// zodResolver generics (see the identical `crossPeriodOverride` note in
// admin/timetable/schema.ts); every real caller already supplies `[]`
// explicitly as the default form value, so requiring it costs nothing.
const availableDaysField = z.array(z.enum(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]));

// Required here (unlike the student phoneNumber field, which is purely
// optional WhatsApp metadata) — this doubles as the lecturer's future
// login identifier once an account is generated (see
// admin/lecturer-accounts/actions.ts), so a lecturer can't be registered
// without one.
const phoneNumberField = z
  .string()
  .trim()
  .min(1, "Phone number is required")
  .regex(PHONE_NUMBER_PATTERN, "Enter a valid phone number (e.g. +2526XXXXXXXX)");

export const lecturerRegistrationSchema = z.object({
  staffNo: z.string().trim().min(1, "Staff number is required"),
  fullName: z.string().trim().min(1, "Full name is required"),
  phoneNumber: phoneNumberField,
  title: z.string().trim().optional(),
  // Optional — a lecturer can be registered before their faculty is known,
  // same "fill it in later" fallback as other nullable batch/profile
  // fields in this app (e.g. Class.roomId).
  departmentId: z.string().trim().optional().or(z.literal("")),
  // OPTIONAL — see availableDaysField above. Left empty = unrestricted.
  availableDays: availableDaysField,
});

export type LecturerRegistrationInput = z.infer<typeof lecturerRegistrationSchema>;

const optionalPhoneField = z
  .string()
  .trim()
  .regex(PHONE_NUMBER_PATTERN, "Enter a valid phone number (e.g. +2526XXXXXXXX)")
  .optional()
  .or(z.literal(""));

// Used for editing an EXISTING lecturer's phone (e.g. fixing a typo) —
// optional here only in the Zod-shape sense (the mutation still requires
// a non-blank value; see updateLecturerPhoneNumber's own check) since a
// registered lecturer must keep a phone number once one is required at
// registration time.
export const lecturerPhoneNumberSchema = z.object({
  phoneNumber: optionalPhoneField,
});

export type LecturerPhoneNumberInput = z.infer<typeof lecturerPhoneNumberSchema>;

export const lecturerDepartmentSchema = z.object({
  departmentId: z.string().trim().optional().or(z.literal("")),
});

export type LecturerDepartmentInput = z.infer<typeof lecturerDepartmentSchema>;

// Editing an EXISTING lecturer's availableDays — same narrow single-field
// pattern as lecturerPhoneNumberSchema/lecturerDepartmentSchema.
export const lecturerAvailableDaysSchema = z.object({
  availableDays: availableDaysField,
});

export type LecturerAvailableDaysInput = z.infer<typeof lecturerAvailableDaysSchema>;
