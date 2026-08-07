"use server";

import { revalidatePath } from "next/cache";
import type { Prisma, StudyMode, DayOfWeek } from "@prisma/client";
import { prisma, BULK_TRANSACTION_OPTIONS } from "@/lib/db";
import { requirePermission, getUserAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getDeanDepartmentIds, assignmentDeanWhere, classDeanWhere, lecturerDeanWhere } from "@/lib/dean-scope";
import { getConflictCandidates, getShiftOptions } from "../timetable/queries";
import { findTimetableConflicts } from "@/lib/timetable-conflicts";
import {
  generateTimetableForBatch,
  type AssignmentToSchedule,
  type ShiftTemplate,
  type GenerationResult,
} from "@/lib/auto-timetable";
import { notifyTimetableChange } from "@/lib/whatsapp-notify";
import { groupLecturerAvailabilityRows } from "@/lib/timetable-days";
import {
  previewBatchSchema,
  confirmBatchSchema,
  lecturerAvailabilityUpdatesSchema,
  type PreviewBatchInput,
  type ConfirmBatchInput,
  type LecturerAvailabilityUpdateInput,
} from "./schema";

// Shared select shape for Lecturer.availability, with just enough of each
// referenced Shift to build a LecturerAvailabilityShiftRef (id/name/
// studyMode/period) without a separate lookup — reused by every server-side
// fetch in this module that needs a lecturer's current availability rules.
const lecturerAvailabilityInclude = {
  select: {
    dayOfWeek: true,
    shift: { select: { id: true, name: true, studyMode: true, period: true } },
  },
} as const;

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
          period: true,
          currentSemesterNumber: true,
          roomId: true,
          room: { select: { name: true, campus: { select: { name: true } } } },
        },
      },
      course: { select: { name: true } },
      lecturer: { select: { fullName: true, availability: lecturerAvailabilityInclude } },
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
    list.push({
      id: s.id,
      name: s.name,
      studyMode: s.studyMode,
      period: s.period,
      startTime: s.startTime,
      endTime: s.endTime,
    });
    map.set(s.studyMode, list);
  }
  return map;
}

export interface ClassWithoutRoom {
  classId: string;
  className: string;
}

// Same shape, same "report, never guess" treatment as ClassWithoutRoom —
// an FT class whose period (Morning/Afternoon) hasn't been assigned yet.
// PT classes never appear here (period is FT-only).
export interface ClassWithoutPeriod {
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
  // FT classes among this batch's assignments with no Class.period set —
  // same "report and exclude, never guess" treatment as classesWithoutRoom.
  // PT classes never appear here, since PT has no period concept at all.
  classesWithoutPeriod: ClassWithoutPeriod[];
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
  const classesWithoutPeriod = new Map<string, ClassWithoutPeriod>();
  for (const req of data.assignments) {
    const row = byId.get(req.assignmentId);
    if (!row) continue; // out of scope / wrong semester-level — already reported above
    if (row.creditHours === null) continue; // defensive — should never happen for a workload-import row

    if (!row.class.roomId || !row.class.room) {
      classesWithoutRoom.set(row.classId, { classId: row.classId, className: row.class.name });
      continue;
    }

    // Period is FT-only, and required going forward — an FT class with
    // none assigned yet is reported and excluded, never guessed. PT
    // classes always have period === null and are never flagged here.
    if (row.class.studyMode === "FT" && !row.class.period) {
      classesWithoutPeriod.set(row.classId, { classId: row.classId, className: row.class.name });
      continue;
    }

    assignmentsToSchedule.push({
      assignmentId: row.id,
      classId: row.classId,
      className: row.class.name,
      studyMode: row.class.studyMode,
      period: row.class.period,
      lecturerId: row.lecturerId,
      lecturerName: row.lecturer.fullName,
      lecturerAvailability: groupLecturerAvailabilityRows(row.lecturer.availability),
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

  return {
    ...result,
    skippedAssignmentIds,
    classesWithoutRoom: [...classesWithoutRoom.values()],
    classesWithoutPeriod: [...classesWithoutPeriod.values()],
  };
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
          crossPeriodOverride: s.crossPeriodOverride,
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

// Resolves the ONE currently-active real Semester the same way every other
// picker on this page already does ("defaults to the active semester" —
// see the workload-import variants' own semester resolution). Clearing a
// timetable is always scoped to whichever Semester is active right now,
// same as generating one.
async function resolveActiveSemester() {
  const semester = await prisma.semester.findFirst({
    where: { isActive: true },
    include: { academicYear: true },
  });
  if (!semester) throw new Error("NO_ACTIVE_SEMESTER");
  return semester;
}

export interface ClassSlotCount {
  classId: string;
  className: string;
  count: number;
}

export interface ClearSemesterPreview {
  semesterId: string;
  semesterLabel: string;
  semesterNumber: number;
  totalCount: number;
  classes: ClassSlotCount[];
}

// Read-only — resolves exactly what "Clear timetable for this semester"
// (below) would delete, so the confirmation dialog can show the real
// total count and the affected class list before anything is touched.
export async function previewClearSemesterTimetable(semesterNumber: number): Promise<ClearSemesterPreview> {
  const user = await requirePermission("timetable.generate");
  const { isDean, departmentIds } = await getScopeFlags(user.id);
  const semester = await resolveActiveSemester();

  const classWhere: Prisma.ClassWhereInput = {
    currentSemesterNumber: semesterNumber,
    ...(isDean ? classDeanWhere(departmentIds) : {}),
  };

  const slots = await prisma.timetableSlot.findMany({
    where: { assignment: { semesterId: semester.id, class: classWhere } },
    select: { assignment: { select: { classId: true, class: { select: { name: true } } } } },
  });

  const byClass = new Map<string, ClassSlotCount>();
  for (const slot of slots) {
    const classId = slot.assignment.classId;
    const entry = byClass.get(classId) ?? { classId, className: slot.assignment.class.name, count: 0 };
    entry.count += 1;
    byClass.set(classId, entry);
  }

  return {
    semesterId: semester.id,
    semesterLabel: `${semester.name} (${semester.academicYear.name})`,
    semesterNumber,
    totalCount: slots.length,
    classes: [...byClass.values()].sort((a, b) => a.className.localeCompare(b.className)),
  };
}

export interface ClearSemesterResult {
  deleted: number;
  classCount: number;
}

// Deletes EVERY TimetableSlot for EVERY class at `semesterNumber` in the
// active Semester — the batch-level counterpart to
// admin/timetable/actions.ts's clearClassTimetable, for wiping a whole
// generated/manually-built semester level before re-generating. Only ever
// touches TimetableSlot — LecturerCourseAssignment/creditHours (the
// workload-import data) is completely untouched, so
// getPendingAutoTimetableAssignments picks these assignments straight back
// up as "not yet scheduled" the moment this returns, with no need to
// re-import the Excel. Re-resolves the active semester and the dean scope
// fresh (never trusts a client-supplied semesterId) — same defense-in-depth
// as every other confirm action in this module.
export async function clearSemesterLevelTimetable(semesterNumber: number): Promise<ClearSemesterResult> {
  const user = await requirePermission("timetable.generate");
  const { isDean, departmentIds } = await getScopeFlags(user.id);
  const semester = await resolveActiveSemester();

  const classWhere: Prisma.ClassWhereInput = {
    currentSemesterNumber: semesterNumber,
    ...(isDean ? classDeanWhere(departmentIds) : {}),
  };

  const slots = await prisma.timetableSlot.findMany({
    where: { assignment: { semesterId: semester.id, class: classWhere } },
    select: { id: true, assignment: { select: { classId: true } } },
  });

  if (slots.length === 0) {
    return { deleted: 0, classCount: 0 };
  }

  const classCount = new Set(slots.map((s) => s.assignment.classId)).size;

  await prisma.timetableSlot.deleteMany({ where: { id: { in: slots.map((s) => s.id) } } });

  await audit({
    userId: user.id,
    action: "TIMETABLE_SEMESTER_CLEARED",
    entity: "TimetableSlot",
    entityId: semester.id,
    oldValue: { semesterId: semester.id, semesterNumber, deleted: slots.length, classCount },
  });

  // Best-effort, unofficial WhatsApp notification — one call per affected
  // class, not per session, matching every other batch timetable mutation
  // in this module (see lib/whatsapp-notify.ts).
  for (const classId of new Set(slots.map((s) => s.assignment.classId))) {
    await notifyTimetableChange(
      classId,
      "your class timetable has been cleared — all scheduled sessions were removed. Check the Timetable page for details."
    );
  }

  revalidatePath("/admin/timetable");
  revalidatePath("/dean/timetable");
  revalidatePath("/lecturer/timetable");
  revalidatePath("/student/timetable");
  revalidatePath("/admin/workload-import");
  revalidatePath("/dean/workload-import");

  return { deleted: slots.length, classCount };
}

export interface SaveLecturerAvailabilityResult {
  updated: number;
  // How many of the submitted lecturer ids fell outside the caller's dean
  // scope (or didn't resolve to a real lecturer at all) and were silently
  // excluded rather than written — same "never trust client-supplied ids,
  // re-verify at write time" defense-in-depth as every other action in
  // this module.
  skipped: number;
}

// The "Lecturer availability" wizard step's save action — see CLAUDE.md's
// "Lecturer availableDays" business rule. Deliberately re-entered/
// confirmed EVERY generation cycle rather than a one-time Lecturer
// Registration field: availability can change semester to semester, so
// this simply REPLACES each lecturer's ENTIRE LecturerAvailability rule
// set with whatever the admin/dean just set for THIS run (delete-all-
// then-recreate, never a partial merge — this is also what guarantees a
// day never ends up mixing a day-level-only row with shift-set rows, see
// the model's own schema comment), which is exactly what
// generateTimetableForBatch reads moments later when
// previewAutoTimetableBatch runs. Gated on `timetable.generate` (not
// `user.manage`) since this is part of the generation workflow, not
// general lecturer profile management.
export async function saveLecturerAvailableDaysForGeneration(
  updates: LecturerAvailabilityUpdateInput[]
): Promise<SaveLecturerAvailabilityResult> {
  const user = await requirePermission("timetable.generate");
  const data = lecturerAvailabilityUpdatesSchema.parse(updates);
  if (data.length === 0) return { updated: 0, skipped: 0 };

  const { isDean, departmentIds } = await getScopeFlags(user.id);
  const lecturerIds = [...new Set(data.map((d) => d.lecturerId))];
  const scopedLecturers = await prisma.lecturer.findMany({
    where: { id: { in: lecturerIds }, ...(isDean ? lecturerDeanWhere(departmentIds) : {}) },
    select: { id: true, fullName: true, availability: lecturerAvailabilityInclude },
  });
  const scopedById = new Map(scopedLecturers.map((l) => [l.id, l]));
  const inScope = data.filter((d) => scopedById.has(d.lecturerId));
  const skipped = data.length - inScope.length;
  if (inScope.length === 0) return { updated: 0, skipped };

  // Never trust client-supplied shift ids blindly — silently drop any that
  // don't resolve to a real, non-deleted Shift (e.g. stale/since-removed)
  // rather than writing a dangling reference.
  const allShiftIds = [...new Set(inScope.flatMap((u) => u.availability.flatMap((d) => d.shiftIds)))];
  const realShiftIds =
    allShiftIds.length > 0
      ? new Set(
          (await prisma.shift.findMany({ where: { id: { in: allShiftIds }, deletedAt: null }, select: { id: true } })).map(
            (s) => s.id
          )
        )
      : new Set<string>();

  // The final, validated per-lecturer rule set — computed ONCE and reused
  // for both the actual write and the audit's newValue, so the two can
  // never disagree about what was actually saved.
  const cleanedByLecturer = new Map<string, { dayOfWeek: DayOfWeek; shiftIds: string[] }[]>(
    inScope.map((item) => [
      item.lecturerId,
      item.availability.map((d) => ({ dayOfWeek: d.dayOfWeek, shiftIds: d.shiftIds.filter((id) => realShiftIds.has(id)) })),
    ])
  );

  await prisma.$transaction(async (tx) => {
    await tx.lecturerAvailability.deleteMany({ where: { lecturerId: { in: inScope.map((i) => i.lecturerId) } } });
    type NewAvailabilityRow = { lecturerId: string; dayOfWeek: DayOfWeek; shiftId: string | null };
    const createData: NewAvailabilityRow[] = [...cleanedByLecturer.entries()].flatMap(([lecturerId, days]) =>
      days.flatMap((d): NewAvailabilityRow[] =>
        d.shiftIds.length === 0
          ? [{ lecturerId, dayOfWeek: d.dayOfWeek, shiftId: null }]
          : d.shiftIds.map((shiftId) => ({ lecturerId, dayOfWeek: d.dayOfWeek, shiftId }))
      )
    );
    if (createData.length > 0) {
      await tx.lecturerAvailability.createMany({ data: createData });
    }
  }, BULK_TRANSACTION_OPTIONS);

  // Audited with plain {dayOfWeek, shiftIds} per lecturer on both sides
  // (ids only, not resolved shift names) — an audit-log detail, not a
  // user-facing display, same level of detail this action's input/output
  // already carries.
  await audit({
    userId: user.id,
    action: "LECTURER_AVAILABLE_DAYS_SET_FOR_GENERATION",
    entity: "Lecturer",
    oldValue: {
      lecturers: inScope.map((item) => {
        const before = scopedById.get(item.lecturerId)!;
        return {
          lecturerId: item.lecturerId,
          fullName: before.fullName,
          availability: before.availability.map((a) => ({ dayOfWeek: a.dayOfWeek, shiftId: a.shift?.id ?? null })),
        };
      }),
    },
    newValue: {
      lecturers: inScope.map((item) => ({
        lecturerId: item.lecturerId,
        fullName: scopedById.get(item.lecturerId)!.fullName,
        availability: cleanedByLecturer.get(item.lecturerId),
      })),
    },
  });

  return { updated: inScope.length, skipped };
}
