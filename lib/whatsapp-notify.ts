import { prisma } from "@/lib/db";
import type { WhatsAppEventType } from "@prisma/client";
import {
  DEFAULT_WHATSAPP_TEMPLATES,
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

// In-memory cache of the effective template per event type — same
// short-TTL/explicit-invalidate shape as lib/permission-cache.ts. There
// are only 3 rows total, so this is really about avoiding a DB round
// trip on every single enqueue call (e.g. once per student in a
// publish/timetable-change fan-out), not about memory.
const TEMPLATE_CACHE_TTL_MS = 60_000;
let templateCache: { entries: Map<WhatsAppEventType, string>; expiresAt: number } | null = null;

// Called by admin/whatsapp/actions.ts right after a template is saved or
// reset, so an edit takes effect immediately on this instance rather than
// waiting out the TTL (same pattern as invalidateUserPermissions).
export function invalidateWhatsAppTemplateCache(): void {
  templateCache = null;
}

async function loadTemplates(): Promise<Map<WhatsAppEventType, string>> {
  if (templateCache && templateCache.expiresAt > Date.now()) {
    return templateCache.entries;
  }
  const rows = await prisma.whatsAppMessageTemplate.findMany();
  const entries = new Map<WhatsAppEventType, string>();
  for (const row of rows) entries.set(row.eventType, row.templateText);
  templateCache = { entries, expiresAt: Date.now() + TEMPLATE_CACHE_TTL_MS };
  return entries;
}

// Resolves the text to actually send for `eventType`: the DB row if it
// exists, is non-blank, and uses only known placeholders — the seeded
// default otherwise. This is the fallback-safety boundary — a missing
// row, an empty string, or a corrupted value with a stray/unknown
// placeholder (e.g. left over from before a Zod validation bug, or
// edited directly in the DB) can never reach an actual outgoing message
// as broken/literal text.
async function getEffectiveTemplate(eventType: WhatsAppEventType): Promise<string> {
  try {
    const entries = await loadTemplates();
    const stored = entries.get(eventType);
    if (
      stored &&
      stored.trim().length > 0 &&
      findUnknownPlaceholders(eventType, stored).length === 0
    ) {
      return stored;
    }
  } catch (error) {
    console.error("[whatsapp-notify] failed to load message templates, using default", error);
  }
  return DEFAULT_WHATSAPP_TEMPLATES[eventType];
}

interface EnqueueParams {
  recipientType: "STUDENT" | "LECTURER";
  recipientId: string;
  recipientName: string;
  phoneNumber: string | null;
  eventType: WhatsAppEventType;
  entity: string;
  entityId: string | null;
  message: string;
}

// The ONLY place that writes a WhatsAppNotificationLog row. Deliberately
// never throws — every call site below is a fire-and-forget hook off a
// core user-facing action (publish results, log a leave notice, edit a
// timetable slot) that must succeed regardless of whether WhatsApp is
// enabled, configured, reachable, or even working at all. Sending itself
// is NOT done here — this only enqueues; the separate VPS worker
// (whatsapp-service/) polls for PENDING rows and does the actual send,
// which is the real fire-and-forget boundary the CLAUDE.md spec asks
// for. A plain awaited insert here is fast (one row) and safer than
// deferring it, since it guarantees the log entry exists before the
// calling Server Action returns.
async function enqueue(params: EnqueueParams): Promise<void> {
  if (!params.phoneNumber) return; // no phone on file — nothing to send

  try {
    const settings = await prisma.whatsAppSettings.findUnique({
      where: { id: WHATSAPP_SETTINGS_ID },
    });
    if (!settings?.enabled) return; // feature off — admin kill switch

    await prisma.whatsAppNotificationLog.create({
      data: {
        recipientType: params.recipientType,
        recipientId: params.recipientId,
        recipientName: params.recipientName,
        phoneNumber: params.phoneNumber,
        eventType: params.eventType,
        entity: params.entity,
        entityId: params.entityId,
        message: params.message,
      },
    });
  } catch (error) {
    // Swallowed on purpose — see the function comment above. A DB hiccup
    // here must never bubble up and fail the publish/create/edit action
    // that triggered it.
    console.error("[whatsapp-notify] failed to enqueue notification", error);
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
    // getEffectiveTemplate's own in-memory cache for why this is cheap
    // even across separate publish calls within the TTL.
    const template = await getEffectiveTemplate("RESULTS_PUBLISHED");

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
        eventType: "RESULTS_PUBLISHED",
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
            user: { select: { fullName: true } },
          },
        },
        relatedStudent: {
          select: { id: true, phoneNumber: true, fullName: true },
        },
      },
    });
    if (!entry) return;

    const template = await getEffectiveTemplate("LEAVE_NOTICE");
    const dateLabel = entry.entryDate.toISOString().slice(0, 10);
    // Pre-composed so the template itself stays a plain substitution —
    // see the DEFAULT_WHATSAPP_TEMPLATES comment in lib/whatsapp-templates.ts.
    const descriptionSuffix = entry.description ? ` — ${entry.description}` : "";

    if (entry.relatedLecturer) {
      await enqueue({
        recipientType: "LECTURER",
        recipientId: entry.relatedLecturer.id,
        recipientName: entry.relatedLecturer.user.fullName,
        phoneNumber: entry.relatedLecturer.phoneNumber,
        eventType: "LEAVE_NOTICE",
        entity: "DailyLogEntry",
        entityId: entryId,
        message: fillTemplate(template, {
          recipientName: entry.relatedLecturer.user.fullName,
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
        eventType: "LEAVE_NOTICE",
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

// Notifies every current student of a class about a timetable change.
// `changeSummary` is the caller-composed tail of the message (e.g. "a
// session was added on Saturday 09:00-10:00") — kept generic/caller-
// supplied so this one function covers create/update/delete/whole-week-
// build without needing a variant per timetable action.
export async function notifyTimetableChange(
  classId: string,
  changeSummary: string
): Promise<void> {
  try {
    const [classRow, students, template] = await Promise.all([
      prisma.class.findUnique({ where: { id: classId }, select: { name: true } }),
      prisma.student.findMany({
        where: { classId },
        select: { id: true, fullName: true, phoneNumber: true },
      }),
      getEffectiveTemplate("TIMETABLE_CHANGE"),
    ]);

    for (const student of students) {
      await enqueue({
        recipientType: "STUDENT",
        recipientId: student.id,
        recipientName: student.fullName,
        phoneNumber: student.phoneNumber,
        eventType: "TIMETABLE_CHANGE",
        entity: "Class",
        entityId: classId,
        message: fillTemplate(template, {
          studentName: student.fullName,
          className: classRow?.name ?? "",
          changeSummary,
        }),
      });
    }
  } catch (error) {
    console.error("[whatsapp-notify] notifyTimetableChange failed", error);
  }
}
