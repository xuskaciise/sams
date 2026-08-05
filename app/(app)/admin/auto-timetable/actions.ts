"use server";

import { revalidatePath } from "next/cache";
import type { Prisma, StudyMode } from "@prisma/client";
import { prisma, BULK_TRANSACTION_OPTIONS } from "@/lib/db";
import { requirePermission, getUserAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getDeanDepartmentIds, assignmentDeanWhere } from "@/lib/dean-scope";
import { getConflictCandidates, getShiftOptions } from "../timetable/queries";
import { findTimetableConflicts } from "@/lib/timetable-conflicts";
import {
  generateTimetableForBatch,
  type AssignmentToSchedule,
  type ShiftTemplate,
  type GenerationResult,
} from "@/lib/auto-timetable";
import { notifyTimetableChange } from "@/lib/whatsapp-notify";
import { previewBatchSchema, confirmBatchSchema, type PreviewBatchInput, type ConfirmBatchInput } from "./schema";

// Same "re-derive scope from the caller's role every call" idiom as every
// other dean-scoped feature — never trust which route got them here.
async function getScopeFlags(userId: string) {
  const { roleNames } = await getUserAccess(userId);
  const isDean = roleNames.includes("DEAN");
  const departmentIds = isDean ? await getDeanDepartmentIds(userId) : [];
  return { isDean, departmentIds };
}

// Loads and re-validates the assignments named in `input` against the DB —
// never trusts the client's own copy of creditHours/names/studyMode. Only
// assignments whose class is dean-scoped (when the caller is a Dean) AND
// genuinely at the requested Class.currentSemesterNumber level AND in the
// requested Semester are included; anything else is silently dropped and
// reported back as `skippedAssignmentIds` so the UI can flag it rather than
// pretend it was scheduled.
async function loadScopedAssignments(userId: string, input: PreviewBatchInput) {
  const { isDean, departmentIds } = await getScopeFlags(userId);
  const assignmentIds = input.assignments.map((a) => a.assignmentId);

  const where: Prisma.LecturerCourseAssignmentWhereInput = {
    id: { in: assignmentIds },
    semesterId: input.semesterId,
    class: { currentSemesterNumber: input.semesterNumber },
    ...(isDean ? assignmentDeanWhere(departmentIds) : {}),
  };

  const rows = await prisma.lecturerCourseAssignment.findMany({
    where,
    include: {
      class: {
        select: {
          id: true,
          name: true,
          studyMode: true,
          currentSemesterNumber: true,
          roomId: true,
          room: { select: { name: true, campus: { select: { name: true } } } },
        },
      },
      course: { select: { name: true } },
      lecturer: { select: { fullName: true } },
    },
  });

  const byId = new Map(rows.map((r) => [r.id, r]));
  const skippedAssignmentIds = assignmentIds.filter((id) => !byId.has(id));

  return { rows, byId, skippedAssignmentIds };
}

async function loadShiftsByStudyMode(): Promise<Map<StudyMode, ShiftTemplate[]>> {
  const shifts = await getShiftOptions();
  const map = new Map<StudyMode, ShiftTemplate[]>();
  for (const s of shifts) {
    const list = map.get(s.studyMode) ?? [];
    list.push({ id: s.id, name: s.name, studyMode: s.studyMode, startTime: s.startTime, endTime: s.endTime });
    map.set(s.studyMode, list);
  }
  return map;
}

export interface ClassWithoutRoom {
  classId: string;
  className: string;
}

export interface PreviewBatchResult extends GenerationResult {
  skippedAssignmentIds: string[];
  // Classes among this batch's assignments with no Class.roomId set —
  // room is a class-registration property now (Academic Structure >
  // Classes), never a per-generate choice, so these are simply reported
  // and EXCLUDED from scheduling rather than blocking the whole batch or
  // silently guessing a room. The UI shows a direct link to set each
  // one's room.
  classesWithoutRoom: ClassWithoutRoom[];
}

// Generates a PREVIEW ONLY — no writes. Re-runnable/discardable freely;
// the caller can tweak shiftOverrideIds and call this again as many times
// as it wants before ever calling confirmAutoTimetableBatch.
export async function previewAutoTimetableBatch(input: PreviewBatchInput): Promise<PreviewBatchResult> {
  const user = await requirePermission("timetable.generate");
  const data = previewBatchSchema.parse(input);

  const { byId, skippedAssignmentIds } = await loadScopedAssignments(user.id, data);

  const assignmentsToSchedule: AssignmentToSchedule[] = [];
  const classesWithoutRoom = new Map<string, ClassWithoutRoom>();
  for (const req of data.assignments) {
    const row = byId.get(req.assignmentId);
    if (!row) continue; // out of scope / wrong semester-level — already reported above
    if (row.creditHours === null) continue; // defensive — should never happen for a workload-import row

    if (!row.class.roomId || !row.class.room) {
      classesWithoutRoom.set(row.classId, { classId: row.classId, className: row.class.name });
      continue;
    }

    assignmentsToSchedule.push({
      assignmentId: row.id,
      classId: row.classId,
      className: row.class.name,
      studyMode: row.class.studyMode,
      lecturerId: row.lecturerId,
      lecturerName: row.lecturer.fullName,
      courseId: row.courseId,
      courseName: row.course.name,
      creditHours: Number(row.creditHours),
      mainRoomId: row.class.roomId,
      mainRoomName: `${row.class.room.name} — ${row.class.room.campus.name}`,
      shiftOverrideIds: req.shiftOverrideIds,
    });
  }

  const [shiftsByStudyMode, existingCandidates] = await Promise.all([
    loadShiftsByStudyMode(),
    getConflictCandidates(data.semesterId),
  ]);

  const result = generateTimetableForBatch(assignmentsToSchedule, shiftsByStudyMode, existingCandidates);

  return { ...result, skippedAssignmentIds, classesWithoutRoom: [...classesWithoutRoom.values()] };
}

export interface ConfirmBatchResult {
  created: number;
  skippedDueToRaceConflict: number;
}

// Writes TimetableSlots for a batch the admin/dean has explicitly clicked
// "Confirm this semester" on. Re-validates every session against FRESH
// conflict candidates right before writing (time may have passed since the
// preview was generated) — same "never trust the client's own copy,
// re-check immediately before the transaction" convention as every other
// confirm action in this app (bulk rooms, student/lecturer bulk import).
export async function confirmAutoTimetableBatch(input: ConfirmBatchInput): Promise<ConfirmBatchResult> {
  const user = await requirePermission("timetable.generate");
  const data = confirmBatchSchema.parse(input);
  const { isDean, departmentIds } = await getScopeFlags(user.id);

  const assignmentIds = [...new Set(data.sessions.map((s) => s.assignmentId))];
  const assignments = await prisma.lecturerCourseAssignment.findMany({
    where: {
      id: { in: assignmentIds },
      semesterId: data.semesterId,
      class: { currentSemesterNumber: data.semesterNumber },
      ...(isDean ? assignmentDeanWhere(departmentIds) : {}),
    },
    include: { class: { select: { id: true, name: true } } },
  });
  const assignmentById = new Map(assignments.map((a) => [a.id, a]));

  const freshCandidates = await getConflictCandidates(data.semesterId);
  const acceptedAsCandidates: typeof freshCandidates = [];
  const toCreate: (typeof data.sessions)[number][] = [];
  let skippedDueToRaceConflict = 0;

  for (const session of data.sessions) {
    const assignment = assignmentById.get(session.assignmentId);
    if (!assignment) {
      skippedDueToRaceConflict++;
      continue;
    }
    const conflicts = findTimetableConflicts(
      {
        dayOfWeek: session.dayOfWeek,
        startTime: session.startTime,
        endTime: session.endTime,
        roomId: session.roomId,
        lecturerId: assignment.lecturerId,
        classId: assignment.classId,
      },
      [...freshCandidates, ...acceptedAsCandidates]
    );
    if (conflicts.length > 0) {
      skippedDueToRaceConflict++;
      continue;
    }
    toCreate.push(session);
    acceptedAsCandidates.push({
      id: `pending:${toCreate.length}`,
      dayOfWeek: session.dayOfWeek,
      startTime: session.startTime,
      endTime: session.endTime,
      roomId: session.roomId,
      roomName: "",
      lecturerId: assignment.lecturerId,
      lecturerName: "",
      classId: assignment.classId,
      className: assignment.class.name,
      courseName: "",
    });
  }

  if (toCreate.length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.timetableSlot.createMany({
        data: toCreate.map((s) => ({
          lecturerCourseAssignmentId: s.assignmentId,
          dayOfWeek: s.dayOfWeek,
          startTime: s.startTime,
          endTime: s.endTime,
          roomId: s.roomId,
        })),
      });
    }, BULK_TRANSACTION_OPTIONS);
  }

  await audit({
    userId: user.id,
    action: "AUTO_TIMETABLE_GENERATED",
    entity: "TimetableSlot",
    newValue: {
      semesterId: data.semesterId,
      classSemesterNumber: data.semesterNumber,
      requested: data.sessions.length,
      created: toCreate.length,
      skippedDueToRaceConflict,
    },
  });

  // Best-effort, unofficial WhatsApp notification — same hook and
  // never-throws guarantee as every other timetable mutation (see
  // lib/whatsapp-notify.ts). One notification per affected class, not per
  // session, matching the whole-week-build convention.
  const affectedClassIds = new Set(toCreate.map((s) => assignmentById.get(s.assignmentId)!.classId));
  for (const classId of affectedClassIds) {
    await notifyTimetableChange(
      classId,
      "your class timetable has changed — sessions were added via auto-generated scheduling. Check the Timetable page for details."
    );
  }

  revalidatePath("/admin/timetable");
  revalidatePath("/dean/timetable");
  revalidatePath("/lecturer/timetable");
  revalidatePath("/student/timetable");
  revalidatePath("/admin/workload-import");
  revalidatePath("/dean/workload-import");

  return { created: toCreate.length, skippedDueToRaceConflict };
}
