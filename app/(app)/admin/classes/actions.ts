"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { classSchema, type ClassInput } from "./schema";

function composeClassData(data: ClassInput) {
  const composedName =
    data.batchCode && data.section && data.studyMode
      ? `${data.batchCode}-${data.section}-${data.studyMode}`
      : data.name!;

  return {
    programId: data.programId,
    name: composedName,
    batchCode: data.batchCode || null,
    section: data.section || null,
    studyMode: data.studyMode ?? null,
    currentSemesterNumber: data.currentSemesterNumber ?? null,
  };
}

export async function createClass(input: ClassInput) {
  await requirePermission("structure.manage");
  const data = classSchema.parse(input);
  await prisma.class.create({ data: composeClassData(data) });
  revalidatePath("/admin/structure");
}

export async function updateClass(id: string, input: ClassInput) {
  await requirePermission("structure.manage");
  const data = classSchema.parse(input);
  await prisma.class.update({ where: { id }, data: composeClassData(data) });
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
