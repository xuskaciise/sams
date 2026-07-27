"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  roomSchema,
  bulkRoomRowsSchema,
  type RoomInput,
  type BulkRoomRow,
} from "./schema";

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

export type BulkRoomRowStatus = "OK" | "DUPLICATE_IN_BATCH" | "ALREADY_EXISTS";

export interface BulkRoomPreviewRow extends BulkRoomRow {
  status: BulkRoomRowStatus;
}

// Read-only — classifies each pasted-list/generated-range row without
// writing anything, mirroring the existing bulk-import preview convention
// (OK / duplicate-in-this-batch / already-exists, every row sharing a
// duplicate name flagged, not just the 2nd+ occurrence). Checked WITHOUT a
// deletedAt filter: Room.name's unique constraint isn't deletedAt-scoped,
// so a soft-deleted room's name would still collide at the DB level even
// though it's invisible in the normal active-rooms list.
export async function previewBulkRooms(
  rows: BulkRoomRow[]
): Promise<BulkRoomPreviewRow[]> {
  await requirePermission("timetable.manage");
  const data = bulkRoomRowsSchema.parse(rows);

  const nameCounts = new Map<string, number>();
  for (const row of data) {
    nameCounts.set(row.name, (nameCounts.get(row.name) ?? 0) + 1);
  }

  const existing = await prisma.room.findMany({
    where: { name: { in: data.map((row) => row.name) } },
    select: { name: true },
  });
  const existingNames = new Set(existing.map((r) => r.name));

  return data.map((row) => {
    let status: BulkRoomRowStatus = "OK";
    if ((nameCounts.get(row.name) ?? 0) > 1) status = "DUPLICATE_IN_BATCH";
    else if (existingNames.has(row.name)) status = "ALREADY_EXISTS";
    return { ...row, status };
  });
}

// Creates only the rows the client already classified as OK, re-checking
// for conflicts immediately before writing rather than trusting the
// preview (state may have moved since) — same
// re-check-right-before-the-transaction rule as bulk-import confirm.
// createMany is a single atomic statement, so no explicit $transaction
// wrapper is needed; skipDuplicates is a defensive second line, not the
// primary guard (the pre-filter above already excludes every conflict).
export async function bulkCreateRooms(rows: BulkRoomRow[]) {
  const user = await requirePermission("timetable.manage");
  const data = bulkRoomRowsSchema.parse(rows);

  const existing = await prisma.room.findMany({
    where: { name: { in: data.map((row) => row.name) } },
    select: { name: true },
  });
  const existingNames = new Set(existing.map((r) => r.name));

  const seen = new Set<string>();
  const toCreate: { name: string; capacity: number | null }[] = [];
  let skipped = 0;

  for (const row of data) {
    if (existingNames.has(row.name) || seen.has(row.name)) {
      skipped++;
      continue;
    }
    seen.add(row.name);
    toCreate.push({ name: row.name, capacity: row.capacity ?? null });
  }

  if (toCreate.length > 0) {
    await prisma.room.createMany({ data: toCreate, skipDuplicates: true });
  }

  await audit({
    userId: user.id,
    action: "TIMETABLE_ROOMS_BULK_CREATED",
    entity: "Room",
    newValue: { requested: data.length, created: toCreate.length, skipped },
  });

  revalidatePath("/admin/timetable");
  revalidatePath("/dean/timetable");

  return { created: toCreate.length, skipped };
}
