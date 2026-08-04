import { z } from "zod";

// LECTURER is intentionally not creatable/editable here — lecturer
// accounts are created only via Lecturer Registration + Lecturer
// Accounts (phone-based login). This form is for ADMIN/DEAN/custom-role
// staff accounts, which still use email.
export const userFormSchema = z.object({
  // A role NAME from the roles table (validated server-side — must exist,
  // must not be STUDENT, must not be LECTURER). Custom roles are allowed.
  role: z.string().trim().min(1, "Role is required"),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Email is required")
    .email("Enter a valid email"),
  fullName: z.string().trim().min(1, "Full name is required"),
});

export type UserFormInput = z.infer<typeof userFormSchema>;
