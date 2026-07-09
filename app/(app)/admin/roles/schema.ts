import { z } from "zod";

export const roleFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Role name is required")
    .max(50, "Keep the name under 50 characters"),
  description: z.string().trim().optional(),
  permissionKeys: z.array(z.string()),
});

export type RoleFormInput = z.infer<typeof roleFormSchema>;

export const userAccessSchema = z.object({
  roleIds: z.array(z.string()),
  overrides: z.array(
    z.object({
      permissionId: z.string(),
      effect: z.enum(["GRANT", "DENY"]),
    })
  ),
});

export type UserAccessInput = z.infer<typeof userAccessSchema>;
