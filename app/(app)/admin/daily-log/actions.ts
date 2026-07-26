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
// widened. The related lecturer (for LEAVE_NOTICE) is deliberately NOT
// scoped the same way — see the comment in queries.ts's
// getDailyLogPanelData for why: the schema has no Lecturer->Department
// relation to scope by, and restricting to "currently teaching in-scope"
// would make a quiet/new faculty's leave notices impossible to log. Which
// faculty the ENTRY is filed under (departmentId, checked above) is the
// real boundary; which lecturer gets named in it is not. The related
// STUDENT (for NOTE/PROBLEM) is the opposite case: a student always has
// a real home department via class -> program, so a DEAN's pick IS
// scoped through studentDeanWhere — no "quiet faculty" problem here.
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

  // LEAVE_NOTICE never needs a typed title — it's derived from the
  // lecturer's name, which is validated as a real lecturer (any active
  // lecturer, not scoped to the dean's faculty — see the module comment
  // above) before the entry is ever created.
  let title = data.title ?? "";
  let relatedLecturerId: string | null = null;
  if (data.type === "LEAVE_NOTICE") {
    const lecturer = await prisma.lecturer.findFirst({
      where: { id: data.relatedLecturerId },
      include: { user: true },
    });
    if (!lecturer) {
      throw new Error("LECTURER_NOT_FOUND");
    }
    relatedLecturerId = lecturer.id;
    title = `Leave notice — ${lecturer.user.fullName}`;
  }

  // NOTE/PROBLEM may optionally reference a student — unlike lecturers, a
  // student always has a real home department (via class -> program), so
  // a DEAN's pick IS scoped through studentDeanWhere (reused, not
  // duplicated) rather than left unscoped like the lecturer picker.
  let relatedStudentId: string | null = null;
  if (data.type !== "LEAVE_NOTICE" && data.relatedStudentId) {
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
