"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission, getUserAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getDeanDepartmentIds, assignmentDeanWhere } from "@/lib/dean-scope";
import { findTimetableConflicts, type ConflictKind } from "@/lib/timetable-conflicts";
import { getConflictCandidates } from "./queries";
import { timetableSlotSchema, type TimetableSlotInput } from "./schema";

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
  const assignment = await prisma.lecturerCourseAssignment.findFirst({ where });
  if (!assignment) throw new Error("ASSIGNMENT_NOT_FOUND");
  return assignment;
}

async function resolveScopedSlot(userId: string, slotId: string) {
  const { isDean, departmentIds } = await getScopeFlags(userId);
  const where: Prisma.TimetableSlotWhereInput = {
    id: slotId,
    ...(isDean ? { assignment: assignmentDeanWhere(departmentIds) } : {}),
  };
  const slot = await prisma.timetableSlot.findFirst({ where });
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

  revalidateTimetablePaths();
}

export async function updateTimetableSlot(id: string, input: TimetableSlotInput) {
  const user = await requirePermission("timetable.manage");
  const data = timetableSlotSchema.parse(input);

  // The slot being edited must itself be in scope, independent of whether
  // the newly-chosen assignment is — a Dean could otherwise retarget an
  // in-scope assignment onto an out-of-scope existing slot id.
  const before = await resolveScopedSlot(user.id, id);
  const assignment = await resolveScopedAssignment(user.id, data.lecturerCourseAssignmentId);
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

  revalidateTimetablePaths();
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

  revalidateTimetablePaths();
}
