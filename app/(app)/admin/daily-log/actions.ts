"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission, getUserAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getDeanDepartmentIds, studentDeanWhere } from "@/lib/dean-scope";
import { dailyLogEntrySchema, type DailyLogEntryInput } from "./schema";

// dailylog.create is held by both ADMIN and DEAN — the permission alone
// doesn't say which faculty they may write to. That's the ROLE's job:
// ADMIN can write to any faculty; DEAN only to one they oversee
// (dean_departments, via lib/dean-scope.ts's getDeanDepartmentIds —
// reused here exactly as everywhere else dean-scoped, never duplicated).
// A DEAN+ADMIN multi-role user is still treated as a Dean for this check,
// same "ownership-check-IS-the-query" spirit as the rest of the
// dean-scoped code: an out-of-scope department is rejected, not silently
// widened.
//
// "Who this is about" (relatedLecturerId / relatedStudentId) is handled
// IDENTICALLY across all three types now — never conditioned on
// data.type, just on which of the two ids was actually submitted (the
// Zod schema already guarantees at most one is ever set, and that
// LEAVE_NOTICE always has exactly one). The lecturer lookup is
// deliberately UNSCOPED by faculty for both ADMIN and DEAN — the schema
// has no Lecturer->Department relation, only a transitive one through
// current course assignments, and scoping by "currently teaching
// in-scope" made the picker empty for any faculty with no active
// assignments yet (found during manual testing). The student lookup is
// the opposite case: a student always has a real home department via
// class -> program, so a DEAN's pick IS scoped through studentDeanWhere
// (reused, not duplicated). Which faculty the ENTRY is filed under
// (departmentId, checked above) is the real boundary either way; who
// gets named inside it is a separate, narrower question.
export async function createDailyLogEntry(input: DailyLogEntryInput) {
  const user = await requirePermission("dailylog.create");
  const data = dailyLogEntrySchema.parse(input);
  const { roleNames } = await getUserAccess(user.id);
  const isDean = roleNames.includes("DEAN");

  let deptIds: string[] = [];
  if (isDean) {
    deptIds = await getDeanDepartmentIds(user.id);
    if (!deptIds.includes(data.departmentId)) {
      throw new Error("FORBIDDEN_DEPARTMENT");
    }
  }

  // LEAVE_NOTICE never needs a typed title — it's derived from whichever
  // of lecturer/student was picked, once that pick is validated as real.
  let title = data.title ?? "";
  let relatedLecturerId: string | null = null;
  let relatedStudentId: string | null = null;

  if (data.relatedLecturerId) {
    const lecturer = await prisma.lecturer.findFirst({
      where: { id: data.relatedLecturerId },
      include: { user: true },
    });
    if (!lecturer) {
      throw new Error("LECTURER_NOT_FOUND");
    }
    relatedLecturerId = lecturer.id;
    if (data.type === "LEAVE_NOTICE") {
      title = `Leave notice — ${lecturer.user.fullName}`;
    }
  } else if (data.relatedStudentId) {
    const student = await prisma.student.findFirst({
      where: {
        id: data.relatedStudentId,
        ...(isDean ? studentDeanWhere(deptIds) : {}),
      },
    });
    if (!student) {
      throw new Error("STUDENT_NOT_FOUND");
    }
    relatedStudentId = student.id;
    if (data.type === "LEAVE_NOTICE") {
      title = `Leave notice — ${student.fullName}`;
    }
  }

  const entry = await prisma.dailyLogEntry.create({
    data: {
      departmentId: data.departmentId,
      authorId: user.id,
      type: data.type,
      relatedLecturerId,
      relatedStudentId,
      title,
      description: data.description || null,
      entryDate: new Date(data.entryDate),
    },
  });

  await audit({
    userId: user.id,
    action: "DAILYLOG_CREATED",
    entity: "DailyLogEntry",
    entityId: entry.id,
    newValue: {
      departmentId: entry.departmentId,
      type: entry.type,
      title: entry.title,
      relatedLecturerId: entry.relatedLecturerId,
      relatedStudentId: entry.relatedStudentId,
    },
  });

  revalidatePath("/admin/daily-log");
  revalidatePath("/dean/daily-log");
}
