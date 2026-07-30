"use server";

import { revalidatePath } from "next/cache";
import * as XLSX from "xlsx";
import type { Prisma, StudyMode } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission, getUserAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getDeanDepartmentIds, assignmentDeanWhere, classDeanWhere } from "@/lib/dean-scope";
import { findTimetableConflicts, type ConflictKind } from "@/lib/timetable-conflicts";
import { isValidDayForStudyMode, DAY_LABELS } from "@/lib/timetable-days";
import { classifyForNow, getCurrentDayAndTime, matchesAnyShiftRange } from "@/lib/timetable-now";
import { notifyTimetableChange } from "@/lib/whatsapp-notify";
import { getConflictCandidates, getSlotsForExport, getShiftOptions, getTimetableSlots } from "./queries";
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
    },
  });

  // Best-effort, unofficial WhatsApp notification (see
  // lib/whatsapp-notify.ts) — never throws, so creating the slot always
  // succeeds regardless of whether WhatsApp is enabled or working.
  await notifyTimetableChange(
    assignment.classId,
    `your class timetable has changed — a session was added on ${DAY_LABELS[data.dayOfWeek]} ${data.startTime}-${data.endTime}. Check the Timetable page for details.`
  );

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
    },
    newValue: {
      lecturerCourseAssignmentId: slot.lecturerCourseAssignmentId,
      dayOfWeek: slot.dayOfWeek,
      startTime: slot.startTime,
      endTime: slot.endTime,
      roomId: slot.roomId,
    },
  });

  // Best-effort, unofficial WhatsApp notification (see
  // lib/whatsapp-notify.ts) — never throws, so updating the slot always
  // succeeds regardless of whether WhatsApp is enabled or working.
  await notifyTimetableChange(
    assignment.classId,
    `your class timetable has changed — a session was updated (now ${DAY_LABELS[data.dayOfWeek]} ${data.startTime}-${data.endTime}). Check the Timetable page for details.`
  );

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

  // Best-effort, unofficial WhatsApp notification (see
  // lib/whatsapp-notify.ts) — never throws, so deleting the slot always
  // succeeds regardless of whether WhatsApp is enabled or working.
  await notifyTimetableChange(
    slot.assignment.classId,
    `your class timetable has changed — a session was removed. Check the Timetable page for details.`
  );

  revalidateTimetablePaths();
}

type ExportSlotRow = Awaited<ReturnType<typeof getSlotsForExport>>[number];

function safeExportFileName(label: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `Timetable_${label.replace(/[^a-z0-9]+/gi, "_")}_${stamp}.xlsx`;
}

function slotToRow(slot: ExportSlotRow, status: string): (string | number)[] {
  return [
    DAY_LABELS[slot.dayOfWeek],
    slot.startTime,
    slot.endTime,
    status,
    slot.assignment.course.name,
    slot.assignment.class.name,
    slot.assignment.lecturer.user.fullName,
    slot.room.name,
    slot.room.campus.name,
    slot.assignment.semester.name,
  ];
}

const EXPORT_HEADER = [
  "Day",
  "Start",
  "End",
  "Status",
  "Course",
  "Class",
  "Lecturer",
  "Room",
  "Campus",
  "Semester",
];

// Exports EXACTLY what the "Now" view currently resolves to — same
// quick-mode resolution (Now / a specific Shift / Full week — the
// quick-select is dynamically generated from the Shift table, so `quick`
// here is either "now", "full", or a Shift id, mirroring panel.tsx's
// resolveNowView exactly) and the same getSlotsForExport scope/filter
// query the on-screen list uses, so the downloaded file can never disagree
// with what's visible at the moment of export. A snapshot, not a live
// document — it doesn't auto-refresh.
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

  let rows: (string | number)[][];
  let fileLabel: string;
  const shift = shifts.find((s) => s.id === params.quick);

  // Mirrors panel.tsx's resolveNowView exactly: an explicit Day filter
  // always wins over "now"'s live/today-only semantics (there's only ONE
  // timetable view — Day is just another filter dimension, not a mode
  // gated behind "now" being off); a Shift resolves against whichever day
  // is in effect (the explicit Day filter, or today if none is set).
  if (params.quick === "now" && !params.dayOfWeek) {
    const { inProgress, next } = classifyForNow(slots, new Date());
    rows = [
      ...inProgress.map((s) => slotToRow(s, "In Progress")),
      ...next.map((s) => slotToRow(s, "Next")),
    ];
    fileLabel = "now";
  } else if (shift) {
    const { day: today } = getCurrentDayAndTime(new Date());
    const effectiveDay = params.dayOfWeek ?? today;
    rows = slots
      .filter((s) => s.dayOfWeek === effectiveDay && matchesAnyShiftRange(s.startTime, [shift]))
      .map((s) => slotToRow(s, "Scheduled"));
    fileLabel = shift.name;
  } else {
    const filtered = params.dayOfWeek
      ? slots.filter((s) => s.dayOfWeek === params.dayOfWeek)
      : slots;
    rows = filtered.map((s) => slotToRow(s, "Scheduled"));
    fileLabel = "full_week";
  }

  const worksheet = XLSX.utils.aoa_to_sheet([EXPORT_HEADER, ...rows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Timetable");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  return { base64: Buffer.from(buffer).toString("base64"), fileName: safeExportFileName(fileLabel) };
}
