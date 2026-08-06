"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { shiftSchema, type ShiftInput } from "./schema";

// Period is FT-only — never trusted for a PT shift even if somehow
// submitted, since it has no period split at all. shiftSchema already
// requires it whenever studyMode is FT (mirrors composeClassData's own
// forcing for Class.period).
function composeShiftData(data: ShiftInput) {
  return { ...data, period: data.studyMode === "FT" ? (data.period ?? null) : null };
}

// shift.manage is deliberately ADMIN-only (unlike timetable.manage, which
// DEAN also holds, scoped to their own faculty) — same reasoning as
// campus.manage/room.manage: shifts are a centrally administered
// time-template convenience, not a per-faculty concern. Reading/using
// shifts (the picker in the session-entry forms) needs no separate key —
// see admin/timetable/queries.ts's getShiftOptions.
export async function createShift(input: ShiftInput) {
  await requirePermission("shift.manage");
  const data = shiftSchema.parse(input);
  await prisma.shift.create({ data: composeShiftData(data) });
  revalidatePath("/admin/timetable");
  revalidatePath("/dean/timetable");
}

export async function updateShift(id: string, input: ShiftInput) {
  await requirePermission("shift.manage");
  const data = shiftSchema.parse(input);
  await prisma.shift.update({ where: { id }, data: composeShiftData(data) });
  revalidatePath("/admin/timetable");
  revalidatePath("/dean/timetable");
}

export async function deactivateShift(id: string) {
  await requirePermission("shift.manage");
  await prisma.shift.update({ where: { id }, data: { deletedAt: new Date() } });
  revalidatePath("/admin/timetable");
  revalidatePath("/dean/timetable");
}

export async function reactivateShift(id: string) {
  await requirePermission("shift.manage");
  await prisma.shift.update({ where: { id }, data: { deletedAt: null } });
  revalidatePath("/admin/timetable");
  revalidatePath("/dean/timetable");
}
