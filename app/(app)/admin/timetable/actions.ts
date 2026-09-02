"use server";

import { revalidatePath } from "next/cache";
import * as XLSX from "xlsx";
import type { DayOfWeek, Prisma, StudyMode } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission, getUserAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getDeanDepartmentIds, assignmentDeanWhere, classDeanWhere } from "@/lib/dean-scope";
import { findTimetableConflicts, type ConflictKind } from "@/lib/timetable-conflicts";
import { isValidDayForStudyMode, DAY_LABELS } from "@/lib/timetable-days";
import { classifyForNow, getCurrentDayAndTime, matchesAnyShiftRange } from "@/lib/timetable-now";
import {
  sendTimetableNotifications,
  getRecentTimetableSend,
  TIMETABLE_RESEND_GUARD_MS,
  WHATSAPP_SETTINGS_ID,
} from "@/lib/whatsapp-notify";
import {
  buildNowGrids,
  rowIdForSession,
  type NowGridGroup,
  type NowGridSession,
} from "./now-grid";
import {
  getConflictCandidates,
  getSlotsForExport,
  getShiftOptions,
  getTimetableSlots,
  resolveTimetableNotificationRecipients,
} from "./queries";
import {
  timetableSlotSchema,
  timetableExportParamsSchema,
  type TimetableSlotInput,
  type TimetableExportParams,
} from "./schema";

function revalidateTimetablePaths() {
  revalidatePath("/admin/timetable");
  revalidatePath("/dean/timetable");
  revalidatePath("/lecturer/timetable");
  revalidatePath("/student/timetable");
}

// timetable.manage is held by both ADMIN and DEAN — same "permission is
// WHAT, dean_departments is WHERE" split as Daily Log. Re-derives the real
// boundary from the caller's ROLE every call, never trusts which route
// got them here.
async function getScopeFlags(userId: string) {
  const { roleNames } = await getUserAccess(userId);
  const isDean = roleNames.includes("DEAN");
  const departmentIds = isDean ? await getDeanDepartmentIds(userId) : [];
  return { isDean, departmentIds };
}

async function resolveScopedAssignment(userId: string, assignmentId: string) {
  const { isDean, departmentIds } = await getScopeFlags(userId);
  const where: Prisma.LecturerCourseAssignmentWhereInput = {
    id: assignmentId,
    ...(isDean ? assignmentDeanWhere(departmentIds) : {}),
  };
  const assignment = await prisma.lecturerCourseAssignment.findFirst({
    where,
    include: { class: { select: { studyMode: true } } },
  });
  if (!assignment) throw new Error("ASSIGNMENT_NOT_FOUND");
  return assignment;
}

function assertValidDay(day: TimetableSlotInput["dayOfWeek"], studyMode: StudyMode | null) {
  if (!isValidDayForStudyMode(day, studyMode)) {
    throw new Error(
      `${DAY_LABELS[day]} is not a valid teaching day for this class's study mode.`
    );
  }
}

async function resolveScopedSlot(userId: string, slotId: string) {
  const { isDean, departmentIds } = await getScopeFlags(userId);
  const where: Prisma.TimetableSlotWhereInput = {
    id: slotId,
    ...(isDean ? { assignment: assignmentDeanWhere(departmentIds) } : {}),
  };
  const slot = await prisma.timetableSlot.findFirst({
    where,
    include: { assignment: { select: { classId: true } } },
  });
  if (!slot) throw new Error("SLOT_NOT_FOUND");
  return slot;
}

function conflictErrorMessage(
  conflicts: { kind: ConflictKind; message: string }[]
): string {
  return conflicts.map((c) => c.message).join(" ");
}

// Live preview for the Add/Edit dialog's inline conflict warning — reuses
// the exact same pure findTimetableConflicts function the real
// create/update pre-check uses below, so the preview can never drift out
// of sync with what actually gets blocked on submit. Still permission-
// gated (only someone who could actually create a slot needs to preview
// conflicts) and still re-validates server-side on the real submit — the
// preview is a convenience, never the enforcement boundary.
export async function checkTimetableConflicts(
  input: TimetableSlotInput,
  excludeSlotId?: string
) {
  const user = await requirePermission("timetable.manage");
  const data = timetableSlotSchema.parse(input);
  const assignment = await resolveScopedAssignment(user.id, data.lecturerCourseAssignmentId);
  assertValidDay(data.dayOfWeek, assignment.class.studyMode);
  const candidates = await getConflictCandidates(assignment.semesterId);

  return findTimetableConflicts(
    {
      dayOfWeek: data.dayOfWeek,
      startTime: data.startTime,
      endTime: data.endTime,
      roomId: data.roomId,
      lecturerId: assignment.lecturerId,
      classId: assignment.classId,
    },
    candidates,
    excludeSlotId
  );
}

export async function createTimetableSlot(input: TimetableSlotInput) {
  const user = await requirePermission("timetable.manage");
  const data = timetableSlotSchema.parse(input);
  const assignment = await resolveScopedAssignment(user.id, data.lecturerCourseAssignmentId);
  assertValidDay(data.dayOfWeek, assignment.class.studyMode);
  const candidates = await getConflictCandidates(assignment.semesterId);

  const conflicts = findTimetableConflicts(
    {
      dayOfWeek: data.dayOfWeek,
      startTime: data.startTime,
      endTime: data.endTime,
      roomId: data.roomId,
      lecturerId: assignment.lecturerId,
      classId: assignment.classId,
    },
    candidates
  );
  if (conflicts.length > 0) {
    throw new Error(conflictErrorMessage(conflicts));
  }

  const slot = await prisma.timetableSlot.create({
    data: {
      lecturerCourseAssignmentId: data.lecturerCourseAssignmentId,
      dayOfWeek: data.dayOfWeek,
      startTime: data.startTime,
      endTime: data.endTime,
      roomId: data.roomId,
      crossPeriodOverride: data.crossPeriodOverride,
    },
  });

  await audit({
    userId: user.id,
    action: "TIMETABLE_SLOT_CREATED",
    entity: "TimetableSlot",
    entityId: slot.id,
    newValue: {
      lecturerCourseAssignmentId: slot.lecturerCourseAssignmentId,
      dayOfWeek: slot.dayOfWeek,
      startTime: slot.startTime,
      endTime: slot.endTime,
      roomId: slot.roomId,
      crossPeriodOverride: slot.crossPeriodOverride,
    },
  });

  // No WhatsApp notification here — timetable notifications are no longer
  // an automatic per-edit hook. They're sent only by the explicit "Send
  // timetable notifications" button (see sendClassTimetableNotifications
  // below / admin/auto-timetable/actions.ts's batch counterpart), so a
  // burst of drag-and-drop edits never spams anyone.
  revalidateTimetablePaths();

  return slot;
}

export async function updateTimetableSlot(id: string, input: TimetableSlotInput) {
  const user = await requirePermission("timetable.manage");
  const data = timetableSlotSchema.parse(input);

  // The slot being edited must itself be in scope, independent of whether
  // the newly-chosen assignment is — a Dean could otherwise retarget an
  // in-scope assignment onto an out-of-scope existing slot id.
  const before = await resolveScopedSlot(user.id, id);
  const assignment = await resolveScopedAssignment(user.id, data.lecturerCourseAssignmentId);
  assertValidDay(data.dayOfWeek, assignment.class.studyMode);
  const candidates = await getConflictCandidates(assignment.semesterId);

  const conflicts = findTimetableConflicts(
    {
      dayOfWeek: data.dayOfWeek,
      startTime: data.startTime,
      endTime: data.endTime,
      roomId: data.roomId,
      lecturerId: assignment.lecturerId,
      classId: assignment.classId,
    },
    candidates,
    id
  );
  if (conflicts.length > 0) {
    throw new Error(conflictErrorMessage(conflicts));
  }

  const slot = await prisma.timetableSlot.update({
    where: { id },
    data: {
      lecturerCourseAssignmentId: data.lecturerCourseAssignmentId,
      dayOfWeek: data.dayOfWeek,
      startTime: data.startTime,
      endTime: data.endTime,
      roomId: data.roomId,
      crossPeriodOverride: data.crossPeriodOverride,
    },
  });

  await audit({
    userId: user.id,
    action: "TIMETABLE_SLOT_UPDATED",
    entity: "TimetableSlot",
    entityId: slot.id,
    oldValue: {
      lecturerCourseAssignmentId: before.lecturerCourseAssignmentId,
      dayOfWeek: before.dayOfWeek,
      startTime: before.startTime,
      endTime: before.endTime,
      roomId: before.roomId,
      crossPeriodOverride: before.crossPeriodOverride,
    },
    newValue: {
      lecturerCourseAssignmentId: slot.lecturerCourseAssignmentId,
      dayOfWeek: slot.dayOfWeek,
      startTime: slot.startTime,
      endTime: slot.endTime,
      roomId: slot.roomId,
      crossPeriodOverride: slot.crossPeriodOverride,
    },
  });

  // No automatic WhatsApp notification — see the note in
  // createTimetableSlot. Use the "Send timetable notifications" button
  // once the class's week is in its final shape.
  revalidateTimetablePaths();

  return slot;
}

// Verifies `classId` is in the caller's scope (a Dean can't fetch another
// faculty's schedule this way) then returns every slot for that class in
// that semester — used by the drag-and-drop Build Timetable grid, which
// needs to render already-placed sessions and isn't tied to the "Now"
// view's own URL-driven Class/Lecturer/Room/Campus filters.
export async function getClassScheduleSlots(classId: string, semesterId: string) {
  const user = await requirePermission("timetable.view");
  const { isDean, departmentIds } = await getScopeFlags(user.id);

  const classRow = await prisma.class.findFirst({
    where: { id: classId, ...(isDean ? classDeanWhere(departmentIds) : {}) },
    select: { id: true },
  });
  if (!classRow) throw new Error("CLASS_NOT_FOUND");

  return getTimetableSlots({ assignment: { classId, semesterId } });
}

export async function deleteTimetableSlot(id: string) {
  const user = await requirePermission("timetable.manage");
  const slot = await resolveScopedSlot(user.id, id);

  await prisma.timetableSlot.delete({ where: { id } });

  await audit({
    userId: user.id,
    action: "TIMETABLE_SLOT_DELETED",
    entity: "TimetableSlot",
    entityId: slot.id,
    oldValue: {
      lecturerCourseAssignmentId: slot.lecturerCourseAssignmentId,
      dayOfWeek: slot.dayOfWeek,
      startTime: slot.startTime,
      endTime: slot.endTime,
      roomId: slot.roomId,
    },
  });

  // No automatic WhatsApp notification — see the note in
  // createTimetableSlot.
  revalidateTimetablePaths();
}

export interface ClearClassTimetableResult {
  deleted: number;
}

// Deletes EVERY TimetableSlot for one class in one semester — the "Clear
// timetable" action on the Timetable Builder, for wiping a previously
// generated/manually-built week before re-generating. Only ever touches
// TimetableSlot: LecturerCourseAssignment (and its creditHours) is never
// modified, so re-generating never needs a fresh workload Excel re-import
// — see CLAUDE.md's "Clear timetable" business rule. Scoped exactly like
// getClassScheduleSlots (the same class+semester pair the builder has
// loaded), dean-scoped via the class lookup.
export async function clearClassTimetable(
  classId: string,
  semesterId: string
): Promise<ClearClassTimetableResult> {
  const user = await requirePermission("timetable.manage");
  const { isDean, departmentIds } = await getScopeFlags(user.id);

  const classRow = await prisma.class.findFirst({
    where: { id: classId, ...(isDean ? classDeanWhere(departmentIds) : {}) },
    select: { id: true, name: true },
  });
  if (!classRow) throw new Error("CLASS_NOT_FOUND");

  const slots = await prisma.timetableSlot.findMany({
    where: { assignment: { classId, semesterId } },
    select: { id: true },
  });
  if (slots.length === 0) return { deleted: 0 };

  await prisma.timetableSlot.deleteMany({ where: { id: { in: slots.map((s) => s.id) } } });

  await audit({
    userId: user.id,
    action: "TIMETABLE_CLEARED",
    entity: "TimetableSlot",
    entityId: classId,
    oldValue: { classId, className: classRow.name, semesterId, deleted: slots.length },
  });

  // No automatic WhatsApp notification — see the note in
  // createTimetableSlot. If students/lecturers should be told the week
  // was wiped, use "Send timetable notifications" after rebuilding it.
  revalidateTimetablePaths();
  // The auto-generate "N assignment(s) not yet scheduled" card
  // (admin/workload-import) re-queries LecturerCourseAssignments with zero
  // TimetableSlots — clearing this class's slots makes its assignments
  // eligible for that card again, so both workload-import routes need to
  // refresh too.
  revalidatePath("/admin/workload-import");
  revalidatePath("/dean/workload-import");

  return { deleted: slots.length };
}

// ============================================================
// Manual "Send timetable notifications" — per class (Timetable Builder).
// Timetable WhatsApp notifications are NO LONGER automatic on slot edits
// (see the notes in createTimetableSlot). One explicit click here messages
// every active student in this class plus every lecturer teaching a
// session in it for the given semester, paced one-per-5s by the worker.
// ============================================================

const TIMETABLE_CHANGE_SUMMARY = (className: string) =>
  `the timetable for ${className} has been updated. Check the SAMS timetable page for your latest schedule.`;

export interface ClassTimetableNotificationsPreview {
  className: string;
  semesterLabel: string;
  studentCount: number;
  lecturerCount: number;
  withPhoneCount: number; // how many recipients actually have a phone number and will be queued
  whatsappEnabled: boolean;
  lastQueuedAt: string | null; // ISO — a previous send for this class within 24h
  stillPending: number; // of that previous send, still un-sent in the worker's queue
}

async function resolveScopedClass(userId: string, classId: string) {
  const { isDean, departmentIds } = await getScopeFlags(userId);
  const classRow = await prisma.class.findFirst({
    where: { id: classId, ...(isDean ? classDeanWhere(departmentIds) : {}) },
    select: { id: true, name: true },
  });
  if (!classRow) throw new Error("CLASS_NOT_FOUND");
  return classRow;
}

// Read-only — drives the confirm dialog (counts + the "already sent at
// [time]" warning) before anything is queued.
export async function previewClassTimetableNotifications(
  classId: string,
  semesterId: string
): Promise<ClassTimetableNotificationsPreview> {
  const user = await requirePermission("timetable.manage");
  const classRow = await resolveScopedClass(user.id, classId);

  const [semester, targets, recent, settings] = await Promise.all([
    prisma.semester.findUnique({
      where: { id: semesterId },
      select: { name: true, academicYear: { select: { name: true } } },
    }),
    resolveTimetableNotificationRecipients([classRow], semesterId),
    getRecentTimetableSend([classId]),
    prisma.whatsAppSettings.findUnique({ where: { id: WHATSAPP_SETTINGS_ID } }),
  ]);

  return {
    className: classRow.name,
    semesterLabel: semester ? `${semester.name} (${semester.academicYear.name})` : "this semester",
    studentCount: targets.studentCount,
    lecturerCount: targets.lecturerCount,
    withPhoneCount: targets.recipients.filter((r) => r.phoneNumber).length,
    whatsappEnabled: settings?.enabled ?? false,
    lastQueuedAt: recent.lastQueuedAt,
    stillPending: recent.stillPending,
  };
}

export interface SendTimetableNotificationsActionResult {
  enqueuedStudents: number;
  enqueuedLecturers: number;
  skipped: number;
  whatsappEnabled: boolean;
}

export async function sendClassTimetableNotifications(
  classId: string,
  semesterId: string,
  force = false
): Promise<SendTimetableNotificationsActionResult> {
  const user = await requirePermission("timetable.manage");
  const classRow = await resolveScopedClass(user.id, classId);

  const settings = await prisma.whatsAppSettings.findUnique({ where: { id: WHATSAPP_SETTINGS_ID } });
  const whatsappEnabled = settings?.enabled ?? false;

  // Duplicate-send guard — a repeat click within the guard window is
  // treated as accidental unless the caller explicitly confirmed "resend
  // anyway". Belt-and-suspenders on top of the client's own warning
  // (the preview surfaces lastQueuedAt) in case the preview was stale.
  if (!force) {
    const recent = await getRecentTimetableSend([classId]);
    if (
      recent.lastQueuedAt &&
      Date.now() - new Date(recent.lastQueuedAt).getTime() < TIMETABLE_RESEND_GUARD_MS
    ) {
      throw new Error("RECENTLY_SENT");
    }
  }

  const { recipients } = await resolveTimetableNotificationRecipients([classRow], semesterId);
  const result = await sendTimetableNotifications({
    recipients,
    changeSummary: TIMETABLE_CHANGE_SUMMARY(classRow.name),
  });

  await audit({
    userId: user.id,
    action: "TIMETABLE_NOTIFICATIONS_SENT",
    entity: "Class",
    entityId: classId,
    newValue: {
      className: classRow.name,
      semesterId,
      scope: "class",
      resent: force,
      ...result,
    },
  });

  revalidatePath("/admin/whatsapp");

  return { ...result, whatsappEnabled };
}

function safeExportFileName(label: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `Timetable_${label.replace(/[^a-z0-9]+/gi, "_")}_${stamp}.xlsx`;
}

// Excel sheet-name rules: <= 31 chars, none of \ / ? * [ ] :, and unique
// within the workbook.
function toSheetName(label: string, used: Set<string>): string {
  const base = (label.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || "Sheet");
  let name = base;
  let n = 2;
  while (used.has(name)) {
    const suffix = ` (${n++})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name);
  return name;
}

const NOW_MARKER: Record<string, string> = { "In Progress": " [NOW]", Next: " [NEXT]" };

function sessionCellText(session: NowGridSession, statusById: Map<string, string>): string {
  return `${session.startTime}–${session.endTime}  ${session.courseName} — ${session.lecturerName} (${session.roomLabel})${
    session.crossPeriodOverride ? " [cross-period]" : ""
  }${NOW_MARKER[statusById.get(session.id) ?? ""] ?? ""}`;
}

// One structure-group grid as a Shift-rows x Day-columns sheet — the same
// layout the read-only <ScheduleGrid> renders on screen (see now-grid.ts).
function groupToAoa(group: NowGridGroup, statusById: Map<string, string>): string[][] {
  const header = ["Shift", ...group.days.map((d) => DAY_LABELS[d])];
  const body = group.rows.map((row) => {
    const cells = group.days.map((day) =>
      group.sessions
        .filter((s) => s.dayOfWeek === day && rowIdForSession(s, group.rows) === row.id)
        .map((s) => sessionCellText(s, statusById))
        .join("\n")
    );
    return [`${row.name} (${row.startTime}–${row.endTime})`, ...cells];
  });
  return [header, ...body];
}

// Exports EXACTLY what the "Now" view currently resolves to, in the SAME
// grid layout it renders on screen — same quick-mode resolution (Now / a
// specific Shift / Full week, `quick` being "now" | "full" | a Shift id,
// mirroring panel.tsx's resolveNowView) and the same getSlotsForExport
// scope/filter query, then the same buildNowGrids structure-group grouping
// (now-grid.ts) so the downloaded workbook — one sheet per group,
// Shift-rows x Day-columns — can never disagree with what's visible. A
// snapshot, not a live document.
export async function exportTimetable(input: TimetableExportParams) {
  const user = await requirePermission("timetable.view");
  const params = timetableExportParamsSchema.parse(input);

  const [slots, shifts] = await Promise.all([
    getSlotsForExport(user.id, {
      classId: params.classId,
      lecturerId: params.lecturerId,
      roomId: params.roomId,
      campusId: params.campusId,
      semesterId: params.semesterId,
    }),
    getShiftOptions(),
  ]);

  const shift = shifts.find((s) => s.id === params.quick);
  const statusById = new Map<string, string>();
  let daySlots: typeof slots;
  let day: DayOfWeek | null;
  let fileLabel: string;

  // Same three branches as resolveNowView: an explicit Day filter always
  // wins over "now"'s live/today-only semantics; a Shift resolves against
  // whichever day is in effect (the Day filter, or today if none).
  if (params.quick === "now" && !params.dayOfWeek) {
    const { day: resolvedDay, inProgress, next } = classifyForNow(slots, new Date());
    for (const s of inProgress) statusById.set(s.id, "In Progress");
    for (const s of next) statusById.set(s.id, "Next");
    daySlots = [...inProgress, ...next];
    day = resolvedDay;
    fileLabel = "now";
  } else if (shift) {
    const { day: today } = getCurrentDayAndTime(new Date());
    const effectiveDay = params.dayOfWeek ?? today;
    daySlots = slots.filter(
      (s) => s.dayOfWeek === effectiveDay && matchesAnyShiftRange(s.startTime, [shift])
    );
    day = effectiveDay;
    fileLabel = shift.name;
  } else {
    daySlots = params.dayOfWeek ? slots.filter((s) => s.dayOfWeek === params.dayOfWeek) : slots;
    day = params.dayOfWeek ?? null;
    fileLabel = "full_week";
  }

  const groups = buildNowGrids(daySlots, shifts, day);
  const workbook = XLSX.utils.book_new();
  if (groups.length === 0) {
    // No matching sessions — a single header-only sheet, never a throw.
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Shift"]]), "Timetable");
  } else {
    const used = new Set<string>();
    for (const group of groups) {
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.aoa_to_sheet(groupToAoa(group, statusById)),
        toSheetName(group.label, used)
      );
    }
  }
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  return { base64: Buffer.from(buffer).toString("base64"), fileName: safeExportFileName(fileLabel) };
}
