import { prisma } from "@/lib/db";
import { getSessionContext } from "@/lib/auth";
import { CampusesClient } from "./campuses-client";

// Campuses have no department/faculty affiliation in the schema —
// unscoped, same as everywhere else this list is read (Rooms, the
// Timetable room picker).
export async function CampusesPanel() {
  const [campuses, ctx] = await Promise.all([
    prisma.campus.findMany({ orderBy: { name: "asc" } }),
    getSessionContext(),
  ]);

  // campus.manage is ADMIN-only — a caller without it (there is currently
  // no route that would even get here without at least campus.manage or
  // room.manage, see nav-items.ts) sees the list read-only, no
  // Add/Edit/Deactivate controls. The server actions are the real
  // boundary either way; this only hides controls that would just come
  // back FORBIDDEN.
  const canManage = ctx?.permissions.has("campus.manage") ?? false;

  return <CampusesClient campuses={campuses} canManage={canManage} />;
}
