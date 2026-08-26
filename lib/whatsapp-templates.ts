import type { WhatsAppTriggerKind } from "@prisma/client";

// Pure logic only — no prisma import. This module is safe to import from
// both server code (lib/whatsapp-notify.ts, admin/whatsapp/actions.ts,
// admin/notifications/send/actions.ts) AND client UI (the Templates tab's
// live preview + inline validation, the Send Notification compose form)
// — pulling prisma in here would leak server-only code into those client
// bundles. Importing WhatsAppTriggerKind is fine even though it comes
// from "@prisma/client": it's a type-only import (a generated string
// literal union), never the prisma runtime client itself.

// ============================================================
// AUTOMATIC events — the fixed catalog of code hooks that actually exist
// (lib/whatsapp-notify.ts's notifyResultsPublished/notifyLeaveNotice/
// notifyTimetableChange, each calling getEffectiveTemplate with one of
// these keys). This is the ONLY place these keys are enumerated — a new
// automatic hook always starts here (add the code hook + an entry here),
// THEN an admin can create its WhatsAppMessageTemplate row from the
// admin UI (admin/whatsapp/actions.ts's createWhatsAppTemplate, which
// only offers keys present here that don't already have a row). Creating
// a template row for an unregistered key is never possible — the UI
// simply won't offer one, and the create action rejects it server-side
// too. This is what "AUTOMATIC types can only be created for hooks that
// already exist in code" means in practice.
export interface AutomaticEventDefinition {
  key: string;
  label: string;
  description: string;
  placeholders: string[];
  defaultTemplateText: string;
}

// The EXACT hardcoded text/placeholders each trigger used before message
// templates existed at all — must stay byte-identical to the seed
// migrations' literals so nothing about an outgoing message changes
// until an admin deliberately edits one. Not every available placeholder
// has to appear in defaultTemplateText — e.g. {mark}/{className}/
// {semesterName} are offered for an admin to add, even though the seeded
// default text doesn't use them.
export const AUTOMATIC_EVENTS: Record<string, AutomaticEventDefinition> = {
  RESULTS_PUBLISHED: {
    key: "RESULTS_PUBLISHED",
    label: "Results published",
    description: "Sent to a student when their result on an assessment is published.",
    placeholders: ["studentName", "courseName", "assessmentTitle", "className", "semesterName", "mark"],
    defaultTemplateText:
      "Hello {studentName}, your results for {courseName} ({assessmentTitle}) have been published. Check the SAMS student portal for details.",
  },
  LEAVE_NOTICE: {
    key: "LEAVE_NOTICE",
    label: "Leave notice",
    description: "Sent to whichever lecturer or student a LEAVE_NOTICE daily-log entry names.",
    placeholders: ["recipientName", "title", "date", "description"],
    defaultTemplateText: "{title} ({date}){description}",
  },
  TIMETABLE_CHANGE: {
    key: "TIMETABLE_CHANGE",
    label: "Timetable change",
    description: "Sent to every current student of a class when its timetable is created, edited, or cleared.",
    placeholders: ["studentName", "className", "changeSummary"],
    defaultTemplateText: "Hello {studentName}, {changeSummary}",
  },
};

export const AUTOMATIC_EVENT_KEYS = Object.keys(AUTOMATIC_EVENTS);

// ============================================================
// MANUAL events — admin-created, sent on demand (see
// admin/notifications/send). Every MANUAL template shares the SAME
// placeholder set, regardless of who created it or what it's for —
// there's no per-template custom placeholder list stored in the DB.
// {message} is the one placeholder the SENDER fills in at send time (a
// free-text box in the compose form); every other one is auto-filled per
// recipient/scope by admin/notifications/send/actions.ts, always present
// (blank string when not applicable to the chosen scope — e.g.
// {facultyName} is blank for an individual-recipient send) so a template
// never shows a literal leftover {token} in a sent message.
export const MANUAL_TEMPLATE_PLACEHOLDERS = [
  "recipientName",
  "senderName",
  "className",
  "facultyName",
  "date",
  "message",
];

export function placeholdersFor(triggerKind: WhatsAppTriggerKind, eventKey: string): string[] {
  if (triggerKind === "MANUAL") return MANUAL_TEMPLATE_PLACEHOLDERS;
  return AUTOMATIC_EVENTS[eventKey]?.placeholders ?? [];
}

// Derives a MANUAL template's immutable eventKey from its admin-typed
// name — "University Holiday" -> "UNIVERSITY_HOLIDAY". Uppercase snake
// case, collapsing anything that isn't A-Z/0-9 into a single underscore
// and trimming leading/trailing ones. Can return "" for a name with no
// letters/digits at all (e.g. "!!!") — callers must reject that rather
// than save an empty key.
export function slugifyEventKey(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const PLACEHOLDER_PATTERN = /\{([a-zA-Z0-9_]+)\}/g;

// Every {placeholder} in `text` that ISN'T in the known set for this
// (triggerKind, eventKey) — empty array means the template is safe to
// use. Used both to reject a save (real typo protection, e.g.
// {studnetName}) and as the runtime safety net deciding whether a stored
// AUTOMATIC template is trustworthy enough to send at all (see
// getEffectiveTemplate in lib/whatsapp-notify.ts).
export function findUnknownPlaceholders(
  triggerKind: WhatsAppTriggerKind,
  eventKey: string,
  text: string
): string[] {
  const known = new Set(placeholdersFor(triggerKind, eventKey));
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
