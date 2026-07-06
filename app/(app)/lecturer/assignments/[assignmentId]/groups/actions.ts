"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAssignmentOwner } from "@/lib/auth";
import { groupNameSchema, type GroupNameInput } from "./schema";

export async function createGroup(assignmentId: string, input: GroupNameInput) {
  await requireAssignmentOwner(assignmentId);
  const data = groupNameSchema.parse(input);

  await prisma.studentGroup.create({
    data: { assignmentId, name: data.name },
  });

  revalidatePath(`/lecturer/assignments/${assignmentId}/groups`);
}

export async function renameGroup(
  assignmentId: string,
  groupId: string,
  input: GroupNameInput
) {
  await requireAssignmentOwner(assignmentId);
  const data = groupNameSchema.parse(input);

  await prisma.studentGroup.update({
    where: { id: groupId },
    data: { name: data.name },
  });

  revalidatePath(`/lecturer/assignments/${assignmentId}/groups`);
}

// Snapshot model: results reference a group by id but store the mark
// independently, so deleting a group never touches saved marks. The only
// risk is losing the ability to see which group a published result came
// from — so once any published result points at this group, block deletion.
export async function deleteGroup(assignmentId: string, groupId: string) {
  await requireAssignmentOwner(assignmentId);

  const publishedResult = await prisma.assessmentResult.findFirst({
    where: { groupId, status: "PUBLISHED" },
  });
  if (publishedResult) {
    throw new Error("HAS_PUBLISHED_RESULTS");
  }

  await prisma.studentGroup.delete({ where: { id: groupId } });

  revalidatePath(`/lecturer/assignments/${assignmentId}/groups`);
}

export async function addGroupMember(
  assignmentId: string,
  groupId: string,
  studentId: string
) {
  await requireAssignmentOwner(assignmentId);

  try {
    await prisma.groupMember.create({
      data: { assignmentId, groupId, studentId },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new Error("ALREADY_IN_GROUP");
    }
    throw error;
  }

  revalidatePath(`/lecturer/assignments/${assignmentId}/groups`);
}

// Removing a member never touches already-saved results (snapshot model) —
// no guard needed here, unlike deleting the group itself.
export async function removeGroupMember(assignmentId: string, memberId: string) {
  await requireAssignmentOwner(assignmentId);

  await prisma.groupMember.delete({ where: { id: memberId } });

  revalidatePath(`/lecturer/assignments/${assignmentId}/groups`);
}
