"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { courseSchema, type CourseInput } from "./schema";

export async function createCourse(input: CourseInput) {
  await requirePermission("curriculum.manage");
  const data = courseSchema.parse(input);
  await prisma.course.create({ data });
  revalidatePath("/admin/curriculum");
}

export async function updateCourse(id: string, input: CourseInput) {
  await requirePermission("curriculum.manage");
  const data = courseSchema.parse(input);
  await prisma.course.update({ where: { id }, data });
  revalidatePath("/admin/curriculum");
}

export async function deactivateCourse(id: string) {
  await requirePermission("curriculum.manage");
  await prisma.course.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  revalidatePath("/admin/curriculum");
}

export async function reactivateCourse(id: string) {
  await requirePermission("curriculum.manage");
  await prisma.course.update({
    where: { id },
    data: { deletedAt: null },
  });
  revalidatePath("/admin/curriculum");
}
