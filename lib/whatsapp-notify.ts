import { prisma } from "@/lib/db";
import {
  AUTOMATIC_EVENTS,
  findUnknownPlaceholders,
  fillTemplate,
} from "@/lib/whatsapp-templates";

// The one WhatsAppSettings row (see prisma/schema.prisma's comment on
// that model) — the app and the separate VPS worker coordinate entirely
// through this row, never a direct call to each other.
export const WHATSAPP_SETTINGS_ID = "singleton";

// Simple international-format guard — the actual number is only ever
// used by the separate VPS worker (whatsapp-service/), never dialed or
// validated more strictly here. Optional "+", 8-15 digits.
export const PHONE_NUMBER_PATTERN = /^\+?[0-9]{8,15}$/;

// In-memory cache of the effective template TEXT per eventKey — same
// short-TTL/explicit-invalidate shape as lib/permission-cache.ts. Keyed
// by the free string eventKey now (not a fixed enum), covering both
// AUTOMATIC and MANUAL rows — there's no fixed row count anymore now
// that admins can create new ones, but this is still about avoiding a
// DB round trip on every single enqueue call (e.g. once per student in a
// publish/timetable-change fan-out), not about memory.
const TEMPLATE_CACHE_TTL_MS = 60_000;
let templateCache: {
  entries: Map<string, { templateText: string; triggerKind: "AUTOMATIC" | "MANUAL" }>;
  expiresAt: number;
} | null = null;

// Called by admin/whatsapp/actions.ts right after a template is saved,
// reset, created, deactivated, or reactivated, so the change takes effect
// immediately on this instance rather than waiting out the TTL (same
// pattern as invalidateUserPermissions).
export function invalidateWhatsAppTemplateCache(): void {
  templateCache = null;
}

async function loadTemplates() {
  if (templateCache && templateCache.expiresAt > Date.now()) {
    return templateCache.entries;
  }
  const rows = await prisma.whatsAppMessageTemplate.findMany({
    where: { deletedAt: null },
  });
  const entries = new Map<string, { templateText: string; triggerKind: "AUTOMATIC" | "MANUAL" }>();
  for (const row of rows) {
    entries.set(row.eventKey, { templateText: row.templateText, triggerKind: row.triggerKind });
  }
  templateCache = { entries, expiresAt: Date.now() + TEMPLATE_CACHE_TTL_MS };
  return entries;
}

// Resolves the text to actually send for an AUTOMATIC hook's eventKey:
// the DB row if it exists, is non-blank, and uses only known
// placeholders — the coded default otherwise. This is the
// fallback-safety boundary — a missing row, an empty string, or a
// corrupted value with a stray/unknown placeholder (e.g. left over from
// before a Zod validation bug, or edited directly in the DB) can never
// reach an actual outgoing message as broken/literal text. AUTOMATIC
// only: a MANUAL template has no coded default to fall back to (see
// sendManualNotification below, which refuses to send instead).
async function getEffectiveAutomaticTemplate(eventKey: string): Promise<string> {
  try {
    const entries = await loadTemplates();
    const stored = entries.get(eventKey);
    if (
      stored &&
      stored.templateText.trim().length > 0 &&
      findUnknownPlaceholders("AUTOMATIC", eventKey, stored.templateText).length === 0
    ) {
      return stored.templateText;
    }
  } catch (error) {
    console.error("[whatsapp-notify] failed to load message templates, using default", error);
  }
  return AUTOMATIC_EVENTS[eventKey]?.defaultTemplateText ?? "";
}

interface EnqueueParams {
  recipientType: "STUDENT" | "LECTURER";
  recipientId: string;
  recipientName: string;
  phoneNumber: string | null;
  eventKey: string;
  entity: string;
  entityId: string | null;
  message: string;
}

// The ONLY place that writes a WhatsAppNotificationLog row. Deliberately
// never throws — every AUTOMATIC call site below is a fire-and-forget
// hook off a core user-facing action (publish results, log a leave
// notice, edit a timetable slot) that must succeed regardless of whether
// WhatsApp is enabled, configured, reachable, or even working at all.
// sendManualNotification (below) also throws this through the same path,
// but its OWN caller — the Send Notification Server Action — is allowed
// to surface a failure to the sender, since that's a deliberate one-off
// action, not a side effect of something else. Sending itself is NOT
// done here — this only enqueues; the separate VPS worker
// (whatsapp-service/) polls for PENDING rows and does the actual send,
// which is the real fire-and-forget boundary the CLAUDE.md spec asks
// for. A plain awaited insert here is fast (one row) and safer than
// deferring it, since it guarantees the log entry exists before the
// calling Server Action returns.
async function enqueue(params: EnqueueParams): Promise<boolean> {
  if (!params.phoneNumber) return false; // no phone on file — nothing to send

  try {
    const settings = await prisma.whatsAppSettings.findUnique({
      where: { id: WHATSAPP_SETTINGS_ID },
    });
    if (!settings?.enabled) return false; // feature off — admin kill switch

    await prisma.whatsAppNotificationLog.create({
      data: {
        recipientType: params.recipientType,
        recipientId: params.recipientId,
        recipientName: params.recipientName,
        phoneNumber: params.phoneNumber,
        eventKey: params.eventKey,
        entity: params.entity,
        entityId: params.entityId,
        message: params.message,
      },
    });
    return true;
  } catch (error) {
    // Swallowed on purpose — see the function comment above. A DB hiccup
    // here must never bubble up and fail the publish/create/edit action
    // that triggered it.
    console.error("[whatsapp-notify] failed to enqueue notification", error);
    return false;
  }
}

// Notifies every student with a published result on this assessment.
// Called after publishAssessment's transaction commits — never throws,
// so publishing itself always succeeds independent of this.
export async function notifyResultsPublished(assessmentId: string): Promise<void> {
  try {
    const assessment = await prisma.assessment.findUnique({
      where: { id: assessmentId },
      select: {
        title: true,
        assignment: {
          select: {
            course: { select: { name: true } },
            class: { select: { name: true } },
            semester: { select: { name: true } },
          },
        },
      },
    });
    if (!assessment) return;

    const results = await prisma.assessmentResult.findMany({
      where: { assessmentId, status: "PUBLISHED" },
      select: {
        mark: true,
        attendanceStatus: true,
        enrollment: {
          select: {
            student: { select: { id: true, fullName: true, phoneNumber: true } },
          },
        },
      },
    });

    // Fetched ONCE for the whole fan-out, not once per student — see
    // getEffectiveAutomaticTemplate's own in-memory cache for why this is
    // cheap even across separate publish calls within the TTL.
    const template = await getEffectiveAutomaticTemplate("RESULTS_PUBLISHED");

    for (const result of results) {
      const student = result.enrollment.student;
      const markLabel =
        result.mark !== null
          ? result.mark.toString()
          : result.attendanceStatus === "ABSENT"
            ? "Absent"
            : result.attendanceStatus === "EXEMPT"
              ? "Exempt"
              : "—";
      await enqueue({
        recipientType: "STUDENT",
        recipientId: student.id,
        recipientName: student.fullName,
        phoneNumber: student.phoneNumber,
        eventKey: "RESULTS_PUBLISHED",
        entity: "Assessment",
        entityId: assessmentId,
        message: fillTemplate(template, {
          studentName: student.fullName,
          courseName: assessment.assignment.course.name,
          assessmentTitle: assessment.title,
          className: assessment.assignment.class.name,
          semesterName: assessment.assignment.semester.name,
          mark: markLabel,
        }),
      });
    }
  } catch (error) {
    console.error("[whatsapp-notify] notifyResultsPublished failed", error);
  }
}

// Notifies whichever single party a LEAVE_NOTICE entry names — a
// lecturer via relatedLecturerId or a student via relatedStudentId,
// identical handling either way (same "which id is set, not which type"
// pattern createDailyLogEntry already uses). Called only for
// type === "LEAVE_NOTICE"; NOTE/PROBLEM entries never notify.
export async function notifyLeaveNotice(entryId: string): Promise<void> {
  try {
    const entry = await prisma.dailyLogEntry.findUnique({
      where: { id: entryId },
      select: {
        title: true,
        description: true,
        entryDate: true,
        relatedLecturer: {
          select: {
            id: true,
            phoneNumber: true,
            fullName: true,
          },
        },
        relatedStudent: {
          select: { id: true, phoneNumber: true, fullName: true },
        },
      },
    });
    if (!entry) return;

    const template = await getEffectiveAutomaticTemplate("LEAVE_NOTICE");
    const dateLabel = entry.entryDate.toISOString().slice(0, 10);
    // Pre-composed so the template itself stays a plain substitution —
    // see the DEFAULT text comment in lib/whatsapp-templates.ts.
    const descriptionSuffix = entry.description ? ` — ${entry.description}` : "";

    if (entry.relatedLecturer) {
      await enqueue({
        recipientType: "LECTURER",
        recipientId: entry.relatedLecturer.id,
        recipientName: entry.relatedLecturer.fullName,
        phoneNumber: entry.relatedLecturer.phoneNumber,
        eventKey: "LEAVE_NOTICE",
        entity: "DailyLogEntry",
        entityId: entryId,
        message: fillTemplate(template, {
          recipientName: entry.relatedLecturer.fullName,
          title: entry.title,
          date: dateLabel,
          description: descriptionSuffix,
        }),
      });
    } else if (entry.relatedStudent) {
      await enqueue({
        recipientType: "STUDENT",
        recipientId: entry.relatedStudent.id,
        recipientName: entry.relatedStudent.fullName,
        phoneNumber: entry.relatedStudent.phoneNumber,
        eventKey: "LEAVE_NOTICE",
        entity: "DailyLogEntry",
        entityId: entryId,
        message: fillTemplate(template, {
          recipientName: entry.relatedStudent.fullName,
          title: entry.title,
          date: dateLabel,
          description: descriptionSuffix,
        }),
      });
    }
  } catch (error) {
    console.error("[whatsapp-notify] notifyLeaveNotice failed", error);
  }
}

export interface TimetableNotificationRecipient {
  type: "STUDENT" | "LECTURER";
  id: string; // Student.id or Lecturer.id
  name: string;
  phoneNumber: string | null;
  className: string; // fills {className} — a comma-joined list for a lecturer spanning several classes
  classId: string; // the log row's entityId, so "already sent for this batch/class" is queryable
}

export interface SendTimetableNotificationsResult {
  enqueuedStudents: number;
  enqueuedLecturers: number;
  skipped: number; // no phone on file, or the whole feature is off
}

// Timetable notifications are NO LONGER an automatic per-slot-edit hook —
// this is called only from the explicit "Send timetable notifications"
// button (per semester-number batch on Workload Import & Auto-Timetable,
// or per class on the Timetable Builder). The caller
// (admin/auto-timetable/actions.ts / admin/timetable/actions.ts) has
// already resolved the full recipient list — every active student in the
// affected classes plus every lecturer teaching a session in them — with
// dean-scoping applied, exactly like sendManualNotification. This just
// fills the shared TIMETABLE_CHANGE template once and enqueues one row
// per recipient; the separate VPS worker then paces the actual sends
// (one every 5s, see whatsapp-service/) so a large batch never looks
// like a burst. Never throws per recipient — one bad row must not stop
// the rest of the batch — and fully respects the phone-number/enabled
// rules via the same `enqueue` helper every other trigger uses.
export async function sendTimetableNotifications(params: {
  recipients: TimetableNotificationRecipient[];
  changeSummary: string;
}): Promise<SendTimetableNotificationsResult> {
  let enqueuedStudents = 0;
  let enqueuedLecturers = 0;
  let skipped = 0;

  const template = await getEffectiveAutomaticTemplate("TIMETABLE_CHANGE");

  for (const recipient of params.recipients) {
    const ok = await enqueue({
      recipientType: recipient.type,
      recipientId: recipient.id,
      recipientName: recipient.name,
      phoneNumber: recipient.phoneNumber,
      eventKey: "TIMETABLE_CHANGE",
      entity: "Class",
      entityId: recipient.classId,
      message: fillTemplate(template, {
        // Both filled with the recipient's own name so an admin's
        // customized template can use whichever token reads better for a
        // mixed student/lecturer audience.
        studentName: recipient.name,
        recipientName: recipient.name,
        className: recipient.className,
        changeSummary: params.changeSummary,
      }),
    });
    if (ok) {
      if (recipient.type === "STUDENT") enqueuedStudents += 1;
      else enqueuedLecturers += 1;
    } else {
      skipped += 1;
    }
  }

  return { enqueuedStudents, enqueuedLecturers, skipped };
}

// Within this window of a previous "Send timetable notifications" click
// for the same batch/class, a repeat click is treated as an accidental
// double-send — the UI warns and the server refuses unless `force` is
// passed. Long enough to comfortably cover a genuine large batch still
// draining out of the queue at one message / 5s.
export const TIMETABLE_RESEND_GUARD_MS = 10 * 60 * 1000;

export interface RecentTimetableSendInfo {
  lastQueuedAt: string | null; // ISO — most recent TIMETABLE_CHANGE row for these classes in the last 24h
  stillPending: number; // how many of those are still PENDING (worker hasn't sent them yet)
}

// Powers the "notifications for this batch were already sent/queued at
// [time] — resend anyway?" guard on both send buttons. TIMETABLE_CHANGE
// is the ONLY eventKey that writes log rows for a Class now that the
// automatic per-slot hook is gone, so scoping by (eventKey, entity,
// entityId in classIds) is unambiguous.
export async function getRecentTimetableSend(
  classIds: string[]
): Promise<RecentTimetableSendInfo> {
  if (classIds.length === 0) return { lastQueuedAt: null, stillPending: 0 };
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [latest, stillPending] = await Promise.all([
      prisma.whatsAppNotificationLog.findFirst({
        where: {
          eventKey: "TIMETABLE_CHANGE",
          entity: "Class",
          entityId: { in: classIds },
          createdAt: { gte: since },
        },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      prisma.whatsAppNotificationLog.count({
        where: {
          eventKey: "TIMETABLE_CHANGE",
          entity: "Class",
          entityId: { in: classIds },
          status: "PENDING",
        },
      }),
    ]);
    return { lastQueuedAt: latest?.createdAt.toISOString() ?? null, stillPending };
  } catch (error) {
    console.error("[whatsapp-notify] getRecentTimetableSend failed", error);
    return { lastQueuedAt: null, stillPending: 0 };
  }
}

export interface ManualSendRecipient {
  type: "STUDENT" | "LECTURER";
  id: string;
  name: string;
  phoneNumber: string | null;
  // Only meaningful for a STUDENT recipient — used to fill {className}.
  // Left undefined for a LECTURER recipient (fillTemplate then substitutes "").
  className?: string;
}

export interface SendManualNotificationParams {
  templateId: string;
  eventKey: string;
  templateText: string; // already resolved + validated by the caller (admin/notifications/send/actions.ts)
  senderName: string;
  message: string; // the sender's free-typed text — fills {message}
  facultyName: string; // "" unless the send was faculty-scoped
  recipients: ManualSendRecipient[];
}

export interface SendManualNotificationResult {
  enqueued: number;
  skippedNoPhoneOrDisabled: number;
}

// Unlike the AUTOMATIC notify* functions above, this is called directly
// from a Server Action the sender is waiting on (admin/notifications/send
// /actions.ts's sendManualNotification) — so it's allowed to report a
// per-recipient enqueued/skipped count back, rather than being a
// fire-and-forget hook off something else. It still never throws per
// recipient — one bad row must not stop the rest of the batch — and
// still fully respects the existing phone-number/enabled-toggle rules
// via the same `enqueue` helper every AUTOMATIC trigger uses.
export async function sendManualNotification(
  params: SendManualNotificationParams
): Promise<SendManualNotificationResult> {
  let enqueued = 0;
  let skipped = 0;

  for (const recipient of params.recipients) {
    const ok = await enqueue({
      recipientType: recipient.type,
      recipientId: recipient.id,
      recipientName: recipient.name,
      phoneNumber: recipient.phoneNumber,
      eventKey: params.eventKey,
      entity: "WhatsAppMessageTemplate",
      entityId: params.templateId,
      message: fillTemplate(params.templateText, {
        recipientName: recipient.name,
        senderName: params.senderName,
        className: recipient.className ?? "",
        facultyName: params.facultyName,
        date: new Date().toISOString().slice(0, 10),
        message: params.message,
      }),
    });
    if (ok) enqueued += 1;
    else skipped += 1;
  }

  return { enqueued, skippedNoPhoneOrDisabled: skipped };
}

// ============================================================
// wa.me manual-share links — LECTURER_LOGIN_CREDENTIALS and TIMETABLE_READY
// ONLY. These two message types do NOT go through the Baileys worker /
// whatsapp_notification_logs anymore: the admin/dean gets a
// https://wa.me/<number>?text=<message> link, opens it, and hits Send
// themselves inside WhatsApp — this app transmits nothing on its own for
// them. The template wording is still the admin-editable AUTOMATIC
// template (resolved via the same getEffectiveAutomaticTemplate cache +
// fallback), only the delivery mechanism changed. Every OTHER trigger
// (RESULTS_PUBLISHED, LEAVE_NOTICE, TIMETABLE_CHANGE, the generic manual
// Send Notification flow) is unchanged and still enqueues for the worker.
// ============================================================

// Builds a wa.me deep link. Returns null when there's no phone number —
// there's no link to open then. Number is stripped to digits (wa.me
// requires no "+"/spaces), same normalization as the worker's toJid.
export function buildWaMeUrl(phoneNumber: string | null, message: string): string | null {
  if (!phoneNumber) return null;
  const digits = phoneNumber.replace(/\D/g, "");
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

export interface LecturerCredentialsShareParams {
  phoneNumber: string | null;
  username: string;
  tempPassword: string;
  facultyName: string;
  academicYear: string;
  semesterName: string;
  domainName: string;
}

// Fills the LECTURER_LOGIN_CREDENTIALS template with one lecturer's real
// login details and returns a wa.me link the admin opens manually — it
// does NOT enqueue anything for the worker. `url` is null iff the lecturer
// has no phone number on file. Never throws (a template-fetch hiccup falls
// back to the coded default inside getEffectiveAutomaticTemplate).
export async function buildLecturerCredentialsShareUrl(
  params: LecturerCredentialsShareParams
): Promise<{ url: string | null }> {
  const template = await getEffectiveAutomaticTemplate("LECTURER_LOGIN_CREDENTIALS");
  const message = fillTemplate(template, {
    academicYear: params.academicYear,
    semesterName: params.semesterName,
    domainName: params.domainName,
    username: params.username,
    tempPassword: params.tempPassword,
    facultyName: params.facultyName,
  });
  return { url: buildWaMeUrl(params.phoneNumber, message) };
}

export interface TimetableReadyShareParams {
  phoneNumber: string | null;
  semesterName: string;
  academicYear: string;
  domainName: string;
  facultyName: string;
}

// Fills the TIMETABLE_READY template — "your timetable for {semesterName}
// {academicYear} is ready, view it at {domainName}" — and returns a wa.me
// link the admin opens manually. COMPLETELY INDEPENDENT of the credentials
// share (different template, NO username/password) AND does NOT enqueue
// anything for the worker. `url` is null iff no phone number. Never throws.
export async function buildTimetableReadyShareUrl(
  params: TimetableReadyShareParams
): Promise<{ url: string | null }> {
  const template = await getEffectiveAutomaticTemplate("TIMETABLE_READY");
  const message = fillTemplate(template, {
    semesterName: params.semesterName,
    academicYear: params.academicYear,
    domainName: params.domainName,
    facultyName: params.facultyName,
  });
  return { url: buildWaMeUrl(params.phoneNumber, message) };
}
