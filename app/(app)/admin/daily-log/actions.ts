"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission, getUserAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getDeanDepartmentIds, studentDeanWhere } from "@/lib/dean-scope";
import { notifyLeaveNotice } from "@/lib/whatsapp-notify";
import { sumSessionHours, sessionDurationHours } from "@/lib/leave-hours";
import { dailyLogEntrySchema, type DailyLogEntryInput } from "./schema";
import {
  fetchLeaveSessionSlots,
  toLeaveNoticeSessionOptions,
  type LeaveNoticeSessionOption,
} from "./queries";

// Live lookup for the leave-notice form: given the picked person + date,
// return that day's schedulable sessions (course, class, time, hours).
// Same permission gate as creating an entry — a leave-notice author is
// the only one who needs this. The actual resolution is the shared
// fetchLeaveSessionSlots, so this preview can never offer a session the
// create path would then reject.
export async function getLeaveNoticeSessions(input: {
  relatedLecturerId?: string;
  relatedStudentId?: string;
  entryDate: string;
}): Promise<LeaveNoticeSessionOption[]> {
  await requirePermission("dailylog.create");
  if (!input.entryDate) return [];
  if (!input.relatedLecturerId && !input.relatedStudentId) return [];
  const slots = await fetchLeaveSessionSlots({
    relatedLecturerId: input.relatedLecturerId || null,
    relatedStudentId: input.relatedStudentId || null,
    entryDate: input.entryDate,
  });
  return toLeaveNoticeSessionOptions(slots);
}

// dailylog.create is held by both ADMIN and DEAN — the permission alone
// doesn't say which faculty they may write to. That's the ROLE's job:
// ADMIN can write to any faculty; DEAN only to one they oversee
// (dean_departments, via lib/dean-scope.ts's getDeanDepartmentIds —
// reused here exactly as everywhere else dean-scoped, never duplicated).
// A DEAN+ADMIN multi-role user is still treated as a Dean for this check,
// same "ownership-check-IS-the-query" spirit as the rest of the
// dean-scoped code: an out-of-scope department is rejected, not silently
// widened.
//
// "Who this is about" (relatedLecturerId / relatedStudentId) is handled
// IDENTICALLY across all three types now — never conditioned on
// data.type, just on which of the two ids was actually submitted (the
// Zod schema already guarantees at most one is ever set, and that
// LEAVE_NOTICE always has exactly one). The lecturer lookup is
// deliberately UNSCOPED by faculty for both ADMIN and DEAN — the schema
// has no Lecturer->Department relation, only a transitive one through
// current course assignments, and scoping by "currently teaching
// in-scope" made the picker empty for any faculty with no active
// assignments yet (found during manual testing). The student lookup is
// the opposite case: a student always has a real home department via
// class -> program, so a DEAN's pick IS scoped through studentDeanWhere
// (reused, not duplicated). Which faculty the ENTRY is filed under
// (departmentId, checked above) is the real boundary either way; who
// gets named inside it is a separate, narrower question.
export async function createDailyLogEntry(input: DailyLogEntryInput) {
  const user = await requirePermission("dailylog.create");
  const data = dailyLogEntrySchema.parse(input);
  const { roleNames } = await getUserAccess(user.id);
  const isDean = roleNames.includes("DEAN");

  let deptIds: string[] = [];
  if (isDean) {
    deptIds = await getDeanDepartmentIds(user.id);
    if (!deptIds.includes(data.departmentId)) {
      throw new Error("FORBIDDEN_DEPARTMENT");
    }
  }

  // LEAVE_NOTICE never needs a typed title — it's derived from whichever
  // of lecturer/student was picked, once that pick is validated as real.
  let title = data.title ?? "";
  let relatedLecturerId: string | null = null;
  let relatedStudentId: string | null = null;

  if (data.relatedLecturerId) {
    const lecturer = await prisma.lecturer.findFirst({
      where: { id: data.relatedLecturerId },
    });
    if (!lecturer) {
      throw new Error("LECTURER_NOT_FOUND");
    }
    relatedLecturerId = lecturer.id;
    if (data.type === "LEAVE_NOTICE") {
      title = `Leave notice — ${lecturer.fullName}`;
    }
  } else if (data.relatedStudentId) {
    const student = await prisma.student.findFirst({
      where: {
        id: data.relatedStudentId,
        ...(isDean ? studentDeanWhere(deptIds) : {}),
      },
    });
    if (!student) {
      throw new Error("STUDENT_NOT_FOUND");
    }
    relatedStudentId = student.id;
    if (data.type === "LEAVE_NOTICE") {
      title = `Leave notice — ${student.fullName}`;
    }
  }

  // Leave-notice session linking + hours snapshot. Only LEAVE_NOTICE
  // entries link sessions; the ids are re-resolved server-side via the
  // SAME fetchLeaveSessionSlots the form's preview used, so a tampered /
  // stale id that doesn't belong to this person on this day is silently
  // dropped, never trusted. `leaveHours` is the sum of the linked
  // sessions' own durations at THIS moment — stored, never recomputed
  // later (see schema comment). No sessions selected (or a day with none)
  // => leaveHours stays null: the fallback simple note-only entry.
  const requestedSessionIds = new Set(
    data.type === "LEAVE_NOTICE" ? (data.sessionIds ?? []) : []
  );
  let leaveHours: number | null = null;
  let sessionRows: {
    timetableSlotId: string;
    courseName: string;
    className: string;
    startTime: string;
    endTime: string;
    hours: number;
  }[] = [];

  if (requestedSessionIds.size > 0 && (relatedLecturerId || relatedStudentId)) {
    const slots = await fetchLeaveSessionSlots({
      relatedLecturerId,
      relatedStudentId,
      entryDate: data.entryDate,
    });
    sessionRows = slots
      .filter((s) => requestedSessionIds.has(s.id))
      .map((s) => ({
        timetableSlotId: s.id,
        courseName: s.assignment.course.name,
        className: s.assignment.class.name,
        startTime: s.startTime,
        endTime: s.endTime,
        hours: sessionDurationHours(s.startTime, s.endTime),
      }));
    if (sessionRows.length > 0) {
      leaveHours = sumSessionHours(sessionRows);
    }
  }

  const entryData = {
    departmentId: data.departmentId,
    authorId: user.id,
    type: data.type,
    relatedLecturerId,
    relatedStudentId,
    title,
    description: data.description || null,
    entryDate: new Date(data.entryDate),
    leaveHours,
  };

  // A transaction only when there are session rows to write alongside the
  // entry — the common note/problem path stays a single plain create.
  const entry =
    sessionRows.length === 0
      ? await prisma.dailyLogEntry.create({ data: entryData })
      : await prisma.$transaction(async (tx) => {
          const created = await tx.dailyLogEntry.create({ data: entryData });
          await tx.dailyLogEntrySession.createMany({
            data: sessionRows.map((r) => ({
              ...r,
              dailyLogEntryId: created.id,
            })),
          });
          return created;
        });

  await audit({
    userId: user.id,
    action: "DAILYLOG_CREATED",
    entity: "DailyLogEntry",
    entityId: entry.id,
    newValue: {
      departmentId: entry.departmentId,
      type: entry.type,
      title: entry.title,
      relatedLecturerId: entry.relatedLecturerId,
      relatedStudentId: entry.relatedStudentId,
      leaveHours,
      sessionCount: sessionRows.length,
    },
  });

  // Best-effort, unofficial WhatsApp notification (see
  // lib/whatsapp-notify.ts) — only LEAVE_NOTICE entries notify; NOTE/
  // PROBLEM never do. Never throws, so logging the entry always
  // succeeds regardless of whether WhatsApp is enabled or working.
  if (data.type === "LEAVE_NOTICE") {
    await notifyLeaveNotice(entry.id);
  }

  revalidatePath("/admin/daily-log");
  revalidatePath("/dean/daily-log");
}
