"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { audit } from "@/lib/audit";

// CLOSED is a one-way, permanent state: no more entry, correction, or
// publishing for any assessment in this semester (enforced server-side by
// every write action already only allowing DRAFT->edit or PUBLISHED->
// correct — CLOSED matches neither, so it's automatically locked out
// everywhere without those actions needing to know about semesters at
// all). A still-DRAFT assessment closed here can never be published
// afterward — its marks never reach students. That's exactly what the
// confirmation dialog's draft count warns about before this runs.
export async function closeSemester(semesterId: string) {
  const dean = await requireRole("DEAN");

  const semester = await prisma.semester.findUniqueOrThrow({
    where: { id: semesterId },
  });
  if (semester.isClosed) {
    throw new Error("ALREADY_CLOSED");
  }
  if (!semester.isActive) {
    throw new Error("NOT_ACTIVE");
  }

  const assessments = await prisma.assessment.findMany({
    where: {
      assignment: { semesterId },
      deletedAt: null,
      status: { in: ["DRAFT", "PUBLISHED"] },
    },
    select: { id: true, status: true },
  });
  const draftCount = assessments.filter((a) => a.status === "DRAFT").length;

  await prisma.$transaction([
    prisma.semester.update({
      where: { id: semesterId },
      data: { isClosed: true },
    }),
    prisma.assessment.updateMany({
      where: { id: { in: assessments.map((a) => a.id) } },
      data: { status: "CLOSED" },
    }),
  ]);

  await audit({
    userId: dean.id,
    action: "SEMESTER_CLOSED",
    entity: "Semester",
    entityId: semesterId,
    newValue: { assessmentsClosed: assessments.length, draftCountAtClose: draftCount },
  });

  revalidatePath("/dean/close-semester");
  revalidatePath("/dean");
  revalidatePath("/admin/calendar");
}
