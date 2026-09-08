"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission, getUserAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getDeanDepartmentIds, classDeanWhere } from "@/lib/dean-scope";
import {
  buildReassignmentPlan,
  type ReassignmentPlan,
  type ScopedClassForReassignment,
} from "../classes/room-propagation";
import { roomReassignmentSchema, type RoomReassignmentInput } from "./schema";

async function resolveScope(userId: string) {
  const { roleNames } = await getUserAccess(userId);
  const isDean = roleNames.includes("DEAN");
  const departmentIds = isDean ? await getDeanDepartmentIds(userId) : [];
  return { isDean, departmentIds };
}

// Fetch exactly the requested classes, scoped to the caller's faculty
// when they're a Dean — the query IS the scope check. Any submitted id
// that doesn't come back (out of scope, deactivated, or no room set)
// aborts the whole batch.
async function resolveScopedClasses(
  userId: string,
  classIds: string[]
): Promise<ScopedClassForReassignment[]> {
  const { isDean, departmentIds } = await resolveScope(userId);
  const uniqueIds = [...new Set(classIds)];

  const classes = await prisma.class.findMany({
    where: {
      id: { in: uniqueIds },
      deletedAt: null,
      roomId: { not: null },
      ...(isDean ? classDeanWhere(departmentIds) : {}),
    },
    select: {
      id: true,
      name: true,
      roomId: true,
      room: { select: { name: true } },
    },
  });

  if (classes.length < uniqueIds.length) {
    throw new Error(
      "One or more selected classes are not available for reassignment — outside your faculty, deactivated, or has no room assigned."
    );
  }

  return classes.map((c) => ({
    id: c.id,
    name: c.name,
    roomId: c.roomId,
    roomName: c.room?.name ?? null,
  }));
}

export interface RoomReassignmentPreview {
  plan: ReassignmentPlan;
}

export async function previewRoomReassignment(
  input: RoomReassignmentInput
): Promise<RoomReassignmentPreview> {
  const user = await requirePermission("timetable.manage");
  const { rows } = roomReassignmentSchema.parse(input);

  const scoped = await resolveScopedClasses(user.id, rows.map((r) => r.classId));
  const plan = await buildReassignmentPlan(scoped, rows);
  return { plan };
}

export interface RoomReassignmentResult {
  applied: number;
  totalMovedSessions: number;
  changes: {
    className: string;
    oldRoomName: string;
    newRoomName: string;
    movedSessions: number;
  }[];
}

export async function applyRoomReassignment(
  input: RoomReassignmentInput
): Promise<RoomReassignmentResult> {
  const user = await requirePermission("timetable.manage");
  const { rows } = roomReassignmentSchema.parse(input);

  // Re-resolve + re-plan from scratch — never trust the client's plan.
  const scoped = await resolveScopedClasses(user.id, rows.map((r) => r.classId));
  const plan = await buildReassignmentPlan(scoped, rows);

  if (plan.conflicts.length > 0) {
    throw new Error(
      `This reassignment can't be applied — it collides with bookings outside the batch: ${plan.conflicts.join(" ")}`
    );
  }

  // Atomic: every Class.roomId change + every session bulk-propagation in
  // ONE transaction — the same class.update + timetableSlot.updateMany
  // pair "Swap rooms" uses, once per changing class. Either the whole
  // reassignment lands or none of it does.
  const ops = plan.changes.flatMap((c) => [
    prisma.class.update({ where: { id: c.classId }, data: { roomId: c.newRoomId } }),
    prisma.timetableSlot.updateMany({
      where: { assignment: { classId: c.classId } },
      data: { roomId: c.newRoomId },
    }),
  ]);
  await prisma.$transaction(ops);

  const totalMovedSessions = plan.changes.reduce((n, c) => n + c.movedSessions, 0);

  // One audit entry for the whole batch (all classes, old -> new rooms,
  // by whom) — same one-entry-per-batch convention as CLASS_ROOMS_SWAPPED
  // / CLASS_PERIOD_BULK_UPDATED.
  await audit({
    userId: user.id,
    action: "CLASS_ROOMS_REASSIGNED",
    entity: "Class",
    entityId: plan.changes[0]?.classId ?? null,
    oldValue: {
      classes: plan.changes.map((c) => ({
        classId: c.classId,
        className: c.className,
        roomId: c.oldRoomId,
        roomName: c.oldRoomName,
      })),
    },
    newValue: {
      classes: plan.changes.map((c) => ({
        classId: c.classId,
        className: c.className,
        roomId: c.newRoomId,
        roomName: c.newRoomName,
        movedSessions: c.movedSessions,
      })),
      totalMovedSessions,
    },
  });

  revalidatePath("/admin/room-reassignment");
  revalidatePath("/dean/room-reassignment");
  revalidatePath("/admin/structure");
  revalidatePath("/admin/timetable");
  revalidatePath("/dean/timetable");

  return {
    applied: plan.changes.length,
    totalMovedSessions,
    changes: plan.changes.map((c) => ({
      className: c.className,
      oldRoomName: c.oldRoomName,
      newRoomName: c.newRoomName,
      movedSessions: c.movedSessions,
    })),
  };
}
