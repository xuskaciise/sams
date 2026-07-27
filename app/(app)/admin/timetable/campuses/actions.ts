"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { campusSchema, type CampusInput } from "./schema";

// campus.manage is deliberately ADMIN-only (unlike timetable.manage,
// which DEAN also holds, scoped to their own faculty) — campuses have no
// department/faculty affiliation in the schema, and the physical
// inventory is centrally administered, not something a Dean manages.
export async function createCampus(input: CampusInput) {
  await requirePermission("campus.manage");
  const data = campusSchema.parse(input);
  await prisma.campus.create({
    data: { name: data.name, address: data.address || null },
  });
  revalidatePath("/admin/timetable");
  revalidatePath("/dean/timetable");
}

export async function updateCampus(id: string, input: CampusInput) {
  await requirePermission("campus.manage");
  const data = campusSchema.parse(input);
  await prisma.campus.update({
    where: { id },
    data: { name: data.name, address: data.address || null },
  });
  revalidatePath("/admin/timetable");
  revalidatePath("/dean/timetable");
}

export async function deactivateCampus(id: string) {
  await requirePermission("campus.manage");
  await prisma.campus.update({ where: { id }, data: { deletedAt: new Date() } });
  revalidatePath("/admin/timetable");
  revalidatePath("/dean/timetable");
}

export async function reactivateCampus(id: string) {
  await requirePermission("campus.manage");
  await prisma.campus.update({ where: { id }, data: { deletedAt: null } });
  revalidatePath("/admin/timetable");
  revalidatePath("/dean/timetable");
}
