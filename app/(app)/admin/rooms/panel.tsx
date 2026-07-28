import { prisma } from "@/lib/db";
import { getSessionContext } from "@/lib/auth";
import { RoomsClient } from "./rooms-client";

// Rooms, like Campuses, have no department/faculty affiliation — unscoped,
// same as the Timetable room picker's own read of this table.
export async function RoomsPanel() {
  const [rooms, campuses, ctx] = await Promise.all([
    prisma.room.findMany({
      where: { deletedAt: null },
      include: { campus: true },
      orderBy: [{ campus: { name: "asc" } }, { name: "asc" }],
    }),
    prisma.campus.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
    getSessionContext(),
  ]);

  // room.manage is ADMIN-only — see the matching comment in
  // ../campuses/panel.tsx.
  const canManage = ctx?.permissions.has("room.manage") ?? false;

  return <RoomsClient rooms={rooms} campuses={campuses} canManage={canManage} />;
}
