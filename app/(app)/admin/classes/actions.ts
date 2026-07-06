"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { classSchema, type ClassInput } from "./schema";

export async function createClass(input: ClassInput) {
  await requireRole("ADMIN");
  const data = classSchema.parse(input);
  await prisma.class.create({ data });
  revalidatePath("/admin/classes");
}

export async function updateClass(id: string, input: ClassInput) {
  await requireRole("ADMIN");
  const data = classSchema.parse(input);
  await prisma.class.update({ where: { id }, data });
  revalidatePath("/admin/classes");
}

export async function deactivateClass(id: string) {
  await requireRole("ADMIN");
  await prisma.class.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  revalidatePath("/admin/classes");
}

export async function reactivateClass(id: string) {
  await requireRole("ADMIN");
  await prisma.class.update({
    where: { id },
    data: { deletedAt: null },
  });
  revalidatePath("/admin/classes");
}
