"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { semesterSchema, type SemesterInput } from "./schema";

export async function createSemester(input: SemesterInput) {
  await requireRole("ADMIN");
  const data = semesterSchema.parse(input);
  await prisma.semester.create({
    data: {
      name: data.name,
      academicYearId: data.academicYearId,
      startDate: new Date(data.startDate),
      endDate: new Date(data.endDate),
    },
  });
  revalidatePath("/admin/semesters");
}

export async function updateSemester(id: string, input: SemesterInput) {
  await requireRole("ADMIN");
  const data = semesterSchema.parse(input);

  const existing = await prisma.semester.findUniqueOrThrow({ where: { id } });
  if (existing.isClosed) {
    throw new Error("CLOSED_SEMESTER");
  }

  await prisma.semester.update({
    where: { id },
    data: {
      name: data.name,
      academicYearId: data.academicYearId,
      startDate: new Date(data.startDate),
      endDate: new Date(data.endDate),
    },
  });
  revalidatePath("/admin/semesters");
}

export async function setActiveSemester(id: string) {
  await requireRole("ADMIN");

  const semester = await prisma.semester.findUniqueOrThrow({ where: { id } });
  if (semester.isClosed) {
    throw new Error("CLOSED_SEMESTER");
  }

  await prisma.$transaction([
    prisma.semester.updateMany({
      where: { academicYearId: semester.academicYearId, isActive: true },
      data: { isActive: false },
    }),
    prisma.semester.update({
      where: { id },
      data: { isActive: true },
    }),
  ]);
  revalidatePath("/admin/semesters");
}
