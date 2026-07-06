"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { courseSchema, type CourseInput } from "./schema";

export async function createCourse(input: CourseInput) {
  await requireRole("ADMIN");
  const data = courseSchema.parse(input);
  await prisma.course.create({ data });
  revalidatePath("/admin/courses");
}

export async function updateCourse(id: string, input: CourseInput) {
  await requireRole("ADMIN");
  const data = courseSchema.parse(input);
  await prisma.course.update({ where: { id }, data });
  revalidatePath("/admin/courses");
}

export async function deactivateCourse(id: string) {
  await requireRole("ADMIN");
  await prisma.course.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  revalidatePath("/admin/courses");
}

export async function reactivateCourse(id: string) {
  await requireRole("ADMIN");
  await prisma.course.update({
    where: { id },
    data: { deletedAt: null },
  });
  revalidatePath("/admin/courses");
}
