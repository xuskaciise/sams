"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { programSchema, type ProgramInput } from "./schema";

export async function createProgram(input: ProgramInput) {
  await requireRole("ADMIN");
  const data = programSchema.parse(input);
  await prisma.program.create({ data });
  revalidatePath("/admin/structure");
}

export async function updateProgram(id: string, input: ProgramInput) {
  await requireRole("ADMIN");
  const data = programSchema.parse(input);
  await prisma.program.update({ where: { id }, data });
  revalidatePath("/admin/structure");
}

export async function deactivateProgram(id: string) {
  await requireRole("ADMIN");
  await prisma.program.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  revalidatePath("/admin/structure");
}

export async function reactivateProgram(id: string) {
  await requireRole("ADMIN");
  await prisma.program.update({
    where: { id },
    data: { deletedAt: null },
  });
  revalidatePath("/admin/structure");
}
