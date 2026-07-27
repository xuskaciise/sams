"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { campusSchema, type CampusInput } from "./schema";

// Same "shared, unscoped, timetable.manage-gated" resource as Room —
// campuses have no department/faculty affiliation in the schema.
export async function createCampus(input: CampusInput) {
  await requirePermission("timetable.manage");
  const data = campusSchema.parse(input);
  await prisma.campus.create({
    data: { name: data.name, address: data.address || null },
  });
  revalidatePath("/admin/timetable");
  revalidatePath("/dean/timetable");
}

export async function updateCampus(id: string, input: CampusInput) {
  await requirePermission("timetable.manage");
  const data = campusSchema.parse(input);
  await prisma.campus.update({
    where: { id },
    data: { name: data.name, address: data.address || null },
  });
  revalidatePath("/admin/timetable");
  revalidatePath("/dean/timetable");
}

export async function deactivateCampus(id: string) {
  await requirePermission("timetable.manage");
  await prisma.campus.update({ where: { id }, data: { deletedAt: new Date() } });
  revalidatePath("/admin/timetable");
  revalidatePath("/dean/timetable");
}

export async function reactivateCampus(id: string) {
  await requirePermission("timetable.manage");
  await prisma.campus.update({ where: { id }, data: { deletedAt: null } });
  revalidatePath("/admin/timetable");
  revalidatePath("/dean/timetable");
}
