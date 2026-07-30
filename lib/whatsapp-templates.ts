import type { WhatsAppEventType } from "@prisma/client";

// Pure logic only — no prisma import. This module is safe to import from
// both server code (lib/whatsapp-notify.ts, admin/whatsapp/actions.ts)
// AND the client Templates UI (for live preview + inline validation
// before submit); pulling prisma in here would leak server-only code
// into that client bundle.

// The known {placeholder} set per trigger — the admin UI lists these as
// "available placeholders", and both save-time validation
// (admin/whatsapp/actions.ts) and the runtime fallback-safety check
// (lib/whatsapp-notify.ts) reject/ignore anything outside this set. Not
// every available placeholder has to appear in the DEFAULT template below
// — {mark}/{className}/{semesterName} etc. are offered for an admin to
// add, even though the seeded default text doesn't use them.
export const WHATSAPP_TEMPLATE_PLACEHOLDERS: Record<WhatsAppEventType, string[]> = {
  RESULTS_PUBLISHED: [
    "studentName",
    "courseName",
    "assessmentTitle",
    "className",
    "semesterName",
    "mark",
  ],
  LEAVE_NOTICE: ["recipientName", "title", "date", "description"],
  TIMETABLE_CHANGE: ["studentName", "className", "changeSummary"],
};

// Human labels, reused by both the delivery-log filter (whatsapp-client)
// and the Templates tab.
export const WHATSAPP_EVENT_TYPE_LABELS: Record<WhatsAppEventType, string> = {
  RESULTS_PUBLISHED: "Results published",
  LEAVE_NOTICE: "Leave notice",
  TIMETABLE_CHANGE: "Timetable change",
};

// The EXACT hardcoded text each trigger used before this table existed —
// must stay byte-identical to the seed migration's literals
// (prisma/migrations/20260730010544_whatsapp_message_templates) and to
// what lib/whatsapp-notify.ts used to send, so seeding this changes
// nothing until an admin deliberately edits one. Note LEAVE_NOTICE's
// {description} value is pre-composed by the caller as either "" or
// " — <text>" (see notifyLeaveNotice) — that's what lets this template
// stay a plain substitution with no conditional logic of its own while
// still reproducing the original "omit the dash when there's no
// description" behavior exactly.
export const DEFAULT_WHATSAPP_TEMPLATES: Record<WhatsAppEventType, string> = {
  RESULTS_PUBLISHED:
    "Hello {studentName}, your results for {courseName} ({assessmentTitle}) have been published. Check the SAMS student portal for details.",
  LEAVE_NOTICE: "{title} ({date}){description}",
  TIMETABLE_CHANGE: "Hello {studentName}, {changeSummary}",
};

const PLACEHOLDER_PATTERN = /\{([a-zA-Z0-9_]+)\}/g;

// Every {placeholder} in `text` that ISN'T in the known set for
// `eventType` — empty array means the template is safe to use. Used both
// to reject a save (real typo protection, e.g. {studnetName}) and as the
// runtime safety net deciding whether a stored template is trustworthy
// enough to send at all (see getEffectiveTemplate in whatsapp-notify.ts).
export function findUnknownPlaceholders(eventType: WhatsAppEventType, text: string): string[] {
  const known = new Set(WHATSAPP_TEMPLATE_PLACEHOLDERS[eventType]);
  const found = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    if (!known.has(match[1])) found.add(match[1]);
  }
  return [...found];
}

// Fills every {placeholder} with its matching value from `vars`. A key
// with no entry in `vars` is left as literal text — callers are expected
// to have already validated the template against the known placeholder
// set, so this never needs to guess at what an unrecognized token means.
export function fillTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(PLACEHOLDER_PATTERN, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole
  );
}
