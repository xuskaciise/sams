"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { promoteClassSchema, type PromoteClassInput } from "./schema";

// Promotion only ever touches Student.classId. Existing enrollments keep
// their original classId/semesterId as the historical record — new
// enrollments for the target class come from "Open semester", not from
// promotion itself.
export async function promoteClass(input: PromoteClassInput) {
  const admin = await requireRole("ADMIN");
  const data = promoteClassSchema.parse(input);

  const sourceClass = await prisma.class.findUniqueOrThrow({
    where: { id: data.sourceClassId },
  });

  if (data.target.mode === "existing" && data.target.classId === data.sourceClassId) {
    throw new Error("SAME_CLASS");
  }

  let targetClassId: string;
  let promotedCount: number;
  try {
    ({ targetClassId, promotedCount } = await prisma.$transaction(async (tx) => {
      const targetClassId =
        data.target.mode === "new"
          ? (
              await tx.class.create({
                data: { name: data.target.name, programId: sourceClass.programId },
              })
            ).id
          : data.target.classId;

      const result = await tx.student.updateMany({
        where: { id: { in: data.studentIds }, classId: data.sourceClassId },
        data: { classId: targetClassId },
      });

      return { targetClassId, promotedCount: result.count };
    }));
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new Error("DUPLICATE_CLASS_NAME");
    }
    throw error;
  }

  await audit({
    userId: admin.id,
    action: "CLASS_PROMOTED",
    entity: "Class",
    entityId: data.sourceClassId,
    newValue: {
      sourceClassId: data.sourceClassId,
      targetClassId,
      studentCount: promotedCount,
    },
  });

  revalidatePath("/admin/class-promotion");
  revalidatePath("/admin/classes");
  revalidatePath("/admin/students");

  return { targetClassId, promotedCount };
}
