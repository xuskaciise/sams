import { prisma } from "@/lib/db";

// Same "class normally keeps one room for its whole week" heuristic
// already used by the single-slot Add/Edit dialog's room prefill
// (admin/timetable/timetable-client.tsx) — the majority room among a
// class's EXISTING TimetableSlots, across any semester. Returns null for a
// class with no sessions placed yet (the generator's UI then requires the
// admin/dean to pick one explicitly, same as Build Timetable's own
// mainRoomId picker when nothing can be inferred).
export async function getClassMainRoomId(classId: string): Promise<string | null> {
  const slots = await prisma.timetableSlot.findMany({
    where: { assignment: { classId } },
    select: { roomId: true },
  });
  if (slots.length === 0) return null;
  const counts = new Map<string, number>();
  for (const s of slots) counts.set(s.roomId, (counts.get(s.roomId) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
