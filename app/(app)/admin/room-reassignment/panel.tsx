import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSessionContext, getUserAccess } from "@/lib/auth";
import { getDeanDepartmentIds, classDeanWhere } from "@/lib/dean-scope";
import { getRoomOptions } from "../timetable/queries";
import { PageHeader } from "@/components/layout/page-header";
import { RoomReassignmentClient } from "./room-reassignment-client";

// Rendered identically at /admin/room-reassignment and
// /dean/room-reassignment — the real scope is re-derived from the
// caller's ROLE here (and again in every action), never from the route,
// same "one implementation, two routes" pattern as Timetable / Daily Log
// / Workload Import.
export async function RoomReassignmentPanel() {
  const ctx = await getSessionContext();
  // The admin/dean section layouts admit any timetable.* holder; this
  // page self-gates on the specific key it needs (same as WhatsAppPanel /
  // WorkloadImportPanel). Every action re-checks it too.
  if (!ctx?.permissions.has("timetable.manage")) {
    redirect("/");
  }

  const { roleNames } = await getUserAccess(ctx.user.id);
  const isDean = roleNames.includes("DEAN");
  const departmentIds = isDean ? await getDeanDepartmentIds(ctx.user.id) : [];

  const [classes, rooms] = await Promise.all([
    prisma.class.findMany({
      where: {
        deletedAt: null,
        // Only classes that already HAVE a room can be reassigned — a
        // class with none is a "Change room" case, not a shuffle.
        roomId: { not: null },
        ...(isDean ? classDeanWhere(departmentIds) : {}),
      },
      include: {
        program: { select: { id: true, name: true } },
        room: { include: { campus: true } },
      },
      orderBy: { name: "asc" },
    }),
    // Unscoped, like every other room picker — rooms have no faculty
    // affiliation.
    getRoomOptions(),
  ]);

  const rows = classes.map((c) => ({
    id: c.id,
    name: c.name,
    programId: c.program.id,
    programName: c.program.name,
    currentSemesterNumber: c.currentSemesterNumber,
    roomId: c.roomId!,
    roomLabel: `${c.room!.name} — ${c.room!.campus.name}`,
    campusId: c.room!.campusId,
    campusName: c.room!.campus.name,
  }));

  const roomOptions = rooms.map((r) => ({
    id: r.id,
    label: `${r.name} — ${r.campus.name}`,
    campusName: r.campus.name,
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Room Reassignment"
        description="Reassign rooms for several classes at once — a chain or cycle is validated and applied as one atomic operation. For a single class use “Change room”; for exactly two, “Swap rooms”."
      />
      <RoomReassignmentClient classes={rows} rooms={roomOptions} />
    </div>
  );
}
