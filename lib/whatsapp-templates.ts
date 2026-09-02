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
// AUTOMATIC events — the fixed catalog of code-registered senders whose
// placeholder set + default text live in code (lib/whatsapp-notify.ts's
// notifyResultsPublished / notifyLeaveNotice — passive hooks — plus
// sendTimetableNotifications / sendLecturerCredentials, which fire on an
// explicit button click, each resolving its template via
// getEffectiveAutomaticTemplate with one of these keys). This is the
// ONLY place these keys are enumerated — a new
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
// Exact seeded text for LECTURER_LOGIN_CREDENTIALS — MUST stay
// byte-identical to the $creds$…$creds$ literal in migration
// 20260831120000_lecturer_credentials_send so "Reset to default" and a
// fresh seed agree. Sent from Lecturer Accounts by an explicit admin
// click (not a passive event) — "AUTOMATIC" here only means "its
// placeholder set and default text live in code", which is what lets it
// carry credential-specific tokens a shared-placeholder MANUAL row
// cannot.
const LECTURER_LOGIN_CREDENTIALS_DEFAULT = `Salaan Macallin Sharaf leh,

Waxaan kuu diyaarinay jadwalkaaga (Timetable) ee sanad-dugsiyeedka cusub {academicYear}, {semesterName}.

Si aad jadwalkaaga u aragto, fadlan gal boggan:
🔗 Domain: {domainName}

Xogta gelitaanka (Login):
👤 Username: {username}
🔒 Password: {tempPassword}

Marka aad markii ugu horreysa gasho, waxaa lagaa qasbi doonaa inaad password-kaaga beddesho.

Haddii aad wax cilad ah la kulanto, fadlan la xariir Xafiiska Kulliyada (Faculty Office).

Kulliyada: {facultyName}

Mahadsanid,
Maamulka Jaamacadda`;

// Exact seeded text for TIMETABLE_READY — MUST stay byte-identical to the
// $ttr$…$ttr$ literal in migration 20260902120000_timetable_ready so
// "Reset to default" and a fresh seed agree. Deliberately carries NO
// username/password placeholders — it is COMPLETELY INDEPENDENT of
// LECTURER_LOGIN_CREDENTIALS (different event, different button,
// different sent-state tracking). Sent from Workload Import &
// Auto-Timetable by an explicit per-lecturer or bulk click.
const TIMETABLE_READY_DEFAULT = `Salaan Macallin Sharaf leh,

Jadwalkaaga (Timetable) ee {semesterName} {academicYear} waa la diyaariyay.

Si aad u aragto, gal boggan: {domainName}

Haddii aad wax cilad ah la kulanto, fadlan la xariir Xafiiska Kulliyada.

Kulliyada: {facultyName}

Mahadsanid,
Maamulka Jaamacadda`;

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
    description:
      "Sent by the explicit \"Send timetable notifications\" button (per semester-number batch, or per class on the Timetable Builder) to every active student in the affected classes AND every lecturer teaching a session in them. NOT sent automatically on individual slot edits anymore. {studentName} and {recipientName} both hold the recipient's own name (a lecturer or a student) — use whichever reads better.",
    placeholders: ["studentName", "recipientName", "className", "changeSummary"],
    defaultTemplateText: "Hello {studentName}, {changeSummary}",
  },
  // Not a passive hook — sent by an explicit per-lecturer or bulk "Send
  // timetable ready" click on Workload Import & Auto-Timetable
  // (admin/auto-timetable/actions.ts). COMPLETELY INDEPENDENT of
  // LECTURER_LOGIN_CREDENTIALS: no username/password placeholders, its
  // own template row, its own per-(lecturer, semester) sent-state
  // tracking (LecturerTimetableNotification). Sending one never affects
  // the other.
  TIMETABLE_READY: {
    key: "TIMETABLE_READY",
    label: "Timetable Ready",
    description:
      "Sent to a lecturer, by an explicit per-lecturer or bulk click on Workload Import & Auto-Timetable, telling them their timetable for a semester is ready to view. Carries NO login credentials — fully separate from Lecturer Login Credentials.",
    placeholders: ["semesterName", "academicYear", "domainName", "facultyName"],
    defaultTemplateText: TIMETABLE_READY_DEFAULT,
  },
  // Not a passive hook — sent by an explicit "Send credentials" click on
  // Lecturer Accounts (admin/lecturer-accounts/actions.ts) after a
  // login is generated. Registered here (rather than as a MANUAL
  // template) so it can carry its own credential-specific placeholder
  // set and a coded default; see LECTURER_LOGIN_CREDENTIALS_DEFAULT above.
  LECTURER_LOGIN_CREDENTIALS: {
    key: "LECTURER_LOGIN_CREDENTIALS",
    label: "Lecturer Login Credentials",
    description:
      "Sent to a lecturer from Lecturer Accounts after their login is generated — carries their username and one-time password.",
    placeholders: [
      "academicYear",
      "semesterName",
      "domainName",
      "username",
      "tempPassword",
      "facultyName",
    ],
    defaultTemplateText: LECTURER_LOGIN_CREDENTIALS_DEFAULT,
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
