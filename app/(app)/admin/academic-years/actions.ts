"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { academicYearSchema, type AcademicYearInput } from "./schema";

export async function createAcademicYear(input: AcademicYearInput) {
  await requirePermission("calendar.manage");
  const data = academicYearSchema.parse(input);
  await prisma.academicYear.create({
    data: {
      name: data.name,
      startDate: new Date(data.startDate),
      endDate: new Date(data.endDate),
    },
  });
  revalidatePath("/admin/calendar");
}

export async function updateAcademicYear(id: string, input: AcademicYearInput) {
  await requirePermission("calendar.manage");
  const data = academicYearSchema.parse(input);
  await prisma.academicYear.update({
    where: { id },
    data: {
      name: data.name,
      startDate: new Date(data.startDate),
      endDate: new Date(data.endDate),
    },
  });
  revalidatePath("/admin/calendar");
}

export async function setActiveAcademicYear(id: string) {
  await requirePermission("calendar.manage");
  await prisma.$transaction([
    prisma.academicYear.updateMany({
      data: { isActive: false },
      where: { isActive: true },
    }),
    prisma.academicYear.update({
      where: { id },
      data: { isActive: true },
    }),
  ]);
  revalidatePath("/admin/calendar");
}
