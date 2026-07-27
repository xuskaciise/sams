"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { roomSchema, type RoomInput } from "./schema";

// Rooms are a shared, institution-wide resource with no department
// affiliation in the schema — unscoped for every timetable.manage holder
// (ADMIN and DEAN alike), same reasoning as the Daily Log lecturer picker.
export async function createRoom(input: RoomInput) {
  await requirePermission("timetable.manage");
  const data = roomSchema.parse(input);
  await prisma.room.create({
    data: { name: data.name, capacity: data.capacity ?? null },
  });
  revalidatePath("/admin/timetable");
  revalidatePath("/dean/timetable");
}

export async function updateRoom(id: string, input: RoomInput) {
  await requirePermission("timetable.manage");
  const data = roomSchema.parse(input);
  await prisma.room.update({
    where: { id },
    data: { name: data.name, capacity: data.capacity ?? null },
  });
  revalidatePath("/admin/timetable");
  revalidatePath("/dean/timetable");
}

export async function deactivateRoom(id: string) {
  await requirePermission("timetable.manage");
  await prisma.room.update({ where: { id }, data: { deletedAt: new Date() } });
  revalidatePath("/admin/timetable");
  revalidatePath("/dean/timetable");
}

export async function reactivateRoom(id: string) {
  await requirePermission("timetable.manage");
  await prisma.room.update({ where: { id }, data: { deletedAt: null } });
  revalidatePath("/admin/timetable");
  revalidatePath("/dean/timetable");
}
