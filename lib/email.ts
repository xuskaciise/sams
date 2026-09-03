import { Resend } from "resend";
import { prisma } from "@/lib/db";
import type { EmailStatus } from "@prisma/client";

// Real automated email via Resend. Config:
//   RESEND_API_KEY  — from https://resend.com (API Keys). REQUIRED to
//                     actually send; unset => every send is a no-op
//                     SKIPPED (graceful degrade, same pattern as
//                     CREDENTIAL_ENCRYPTION_KEY).
//   EMAIL_FROM      — the verified sender, e.g. "SAMS <no-reply@yourdomain>".
//                     Must be a domain verified in the Resend dashboard.
//
// Email carries no WhatsApp-style ban risk, so this is a genuine
// automated send (not a share link) — but it is still FIRE-AND-FORGET:
// `sendEmail` never throws and every failure is swallowed + logged, so a
// bad address or a provider outage can never block account generation or
// result publishing.

const RESEND_API_KEY = process.env.RESEND_API_KEY?.trim() || null;
const EMAIL_FROM = process.env.EMAIL_FROM?.trim() || "SAMS <onboarding@resend.dev>";

let client: Resend | null = null;
function resend(): Resend | null {
  if (!RESEND_API_KEY) return null;
  if (!client) client = new Resend(RESEND_API_KEY);
  return client;
}

export function emailProviderConfigured(): boolean {
  return !!RESEND_API_KEY;
}

export interface SendEmailInput {
  to: string | null;
  subject: string;
  text: string;
  // For the EmailLog row (admin visibility). Omit to skip logging.
  log?: {
    recipientType: "STUDENT" | "LECTURER";
    recipientId: string;
    eventKey: string;
    entity: string;
    entityId?: string | null;
  };
}

async function writeLog(
  input: SendEmailInput,
  status: EmailStatus,
  error: string | null
): Promise<void> {
  if (!input.log) return;
  try {
    await prisma.emailLog.create({
      data: {
        recipientType: input.log.recipientType,
        recipientId: input.log.recipientId,
        recipientEmail: input.to,
        eventKey: input.log.eventKey,
        subject: input.subject,
        status,
        error: error?.slice(0, 2000) ?? null,
        entity: input.log.entity,
        entityId: input.log.entityId ?? null,
      },
    });
  } catch (e) {
    console.error("[email] failed to write EmailLog", e);
  }
}

// Never throws. Returns whether a message actually left the app.
export async function sendEmail(input: SendEmailInput): Promise<{ sent: boolean }> {
  if (!input.to) {
    await writeLog(input, "SKIPPED", "no recipient email on file");
    return { sent: false };
  }
  const r = resend();
  if (!r) {
    await writeLog(input, "SKIPPED", "email provider not configured (RESEND_API_KEY unset)");
    return { sent: false };
  }
  try {
    const { error } = await r.emails.send({
      from: EMAIL_FROM,
      to: input.to,
      subject: input.subject,
      text: input.text,
    });
    if (error) {
      console.error("[email] Resend returned an error", error);
      await writeLog(input, "FAILED", error.message ?? String(error));
      return { sent: false };
    }
    await writeLog(input, "SENT", null);
    return { sent: true };
  } catch (e) {
    console.error("[email] send threw", e);
    await writeLog(input, "FAILED", e instanceof Error ? e.message : String(e));
    return { sent: false };
  }
}
