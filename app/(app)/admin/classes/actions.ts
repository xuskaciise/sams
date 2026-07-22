"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { classSchema, type ClassInput } from "./schema";

// batchCode is never free-typed — it's derived from the program's code +
// the batch's intake year (last 2 digits) whenever intake year, section,
// and study mode are all provided; otherwise this is a legacy/edge-case
// class using the manually-typed `name` fallback. Recomputes on every
// save, so it stays exactly what it was unless an admin deliberately
// edits intake year/section/study mode — it never drifts just because
// "the current year" has moved on.
async function composeClassData(data: ClassInput) {
  let batchCode: string | null = null;
  let composedName = data.name?.trim() || "";

  if (data.intakeYear && data.section && data.studyMode) {
    const program = await prisma.program.findUniqueOrThrow({
      where: { id: data.programId },
    });
    batchCode = `${program.code}${String(data.intakeYear).slice(-2)}`;
    composedName = `${batchCode}-${data.section}-${data.studyMode}`;
  }

  return {
    programId: data.programId,
    name: composedName,
    batchCode,
    intakeYear: batchCode ? data.intakeYear! : null,
    section: data.section || null,
    studyMode: data.studyMode ?? null,
    currentSemesterNumber: data.currentSemesterNumber ?? null,
  };
}

// Pre-checked before create/update (not caught via the DB's unique
// constraint after the fact) so the error can name the conflict directly —
// same pattern as every other duplicate guard in this app. The composed
// name already encodes batchCode+section+studyMode, so this single check
// covers the "batchCode+section+studyMode must be unique" rule too.
async function assertNoDuplicateName(
  programId: string,
  name: string,
  excludeId?: string
) {
  const existing = await prisma.class.findFirst({
    where: {
      programId,
      name,
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
  });
  if (existing) {
    throw new Error(`A class named "${name}" already exists in this program.`);
  }
}

export async function createClass(input: ClassInput) {
  await requirePermission("structure.manage");
  const data = classSchema.parse(input);
  const composed = await composeClassData(data);
  await assertNoDuplicateName(composed.programId, composed.name);
  await prisma.class.create({ data: composed });
  revalidatePath("/admin/structure");
}

export async function updateClass(id: string, input: ClassInput) {
  await requirePermission("structure.manage");
  const data = classSchema.parse(input);
  const composed = await composeClassData(data);
  await assertNoDuplicateName(composed.programId, composed.name, id);
  await prisma.class.update({ where: { id }, data: composed });
  revalidatePath("/admin/structure");
}

export async function deactivateClass(id: string) {
  await requirePermission("structure.manage");
  await prisma.class.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  revalidatePath("/admin/structure");
}

export async function reactivateClass(id: string) {
  await requirePermission("structure.manage");
  await prisma.class.update({
    where: { id },
    data: { deletedAt: null },
  });
  revalidatePath("/admin/structure");
}
