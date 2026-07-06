"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { departmentSchema, type DepartmentInput } from "./schema";

export async function createDepartment(input: DepartmentInput) {
  await requireRole("ADMIN");
  const data = departmentSchema.parse(input);
  await prisma.department.create({ data });
  revalidatePath("/admin/departments");
}

export async function updateDepartment(id: string, input: DepartmentInput) {
  await requireRole("ADMIN");
  const data = departmentSchema.parse(input);
  await prisma.department.update({ where: { id }, data });
  revalidatePath("/admin/departments");
}

export async function deactivateDepartment(id: string) {
  await requireRole("ADMIN");
  await prisma.department.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  revalidatePath("/admin/departments");
}

export async function reactivateDepartment(id: string) {
  await requireRole("ADMIN");
  await prisma.department.update({
    where: { id },
    data: { deletedAt: null },
  });
  revalidatePath("/admin/departments");
}
