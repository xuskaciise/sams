import { z } from "zod";

// `target` intentionally uses one shared vocabulary across every sender
// tier — what the id in `targetId` actually resolves to (a real Class vs.
// a lecturer's own LecturerCourseAssignment for "CLASS", for instance) is
// entirely determined server-side from the caller's own tier
// (lib/notification-recipients.ts's resolveSenderScope), never from
// anything the client sends. This is why there's no separate
// "assignmentId" field for the LECTURER case — the server already knows
// which interpretation applies.
export const sendManualNotificationSchema = z.object({
  templateId: z.string().min(1),
  recipientKind: z.enum(["STUDENT", "LECTURER"]),
  target: z.enum(["INDIVIDUAL", "CLASS", "FACULTY"]),
  targetId: z.string().min(1),
  message: z.string().max(2000).optional().default(""),
});

export type SendManualNotificationInput = z.input<typeof sendManualNotificationSchema>;

export const previewManualNotificationSchema = sendManualNotificationSchema.omit({
  message: true,
  templateId: true,
});

export type PreviewManualNotificationInput = z.input<typeof previewManualNotificationSchema>;
