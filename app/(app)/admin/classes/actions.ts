"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  classSchema,
  bulkClassPeriodSchema,
  type ClassInput,
  type BulkClassPeriodInput,
} from "./schema";

// batchCode is never free-typed — it's derived from the program's code +
// the batch's intake year (last 2 digits) whenever intake year, section,
// and study mode are all provided; otherwise this is a legacy/edge-case
// class using the manually-typed `name` fallback. Recomputes on every
// save, so it stays exactly what it was unless an admin deliberately
// edits intake year/section/study mode — it never drifts just because
// "the current year" has moved on.
async function composeClassData(data: ClassInput) {
  let batchCode: string | null = null;
  let composedName = data.name?.trim() || "";

  if (data.intakeYear && data.section && data.studyMode) {
    const program = await prisma.program.findUniqueOrThrow({
      where: { id: data.programId },
    });
    batchCode = `${program.code}${String(data.intakeYear).slice(-2)}`;
    composedName = `${batchCode}-${data.section}-${data.studyMode}`;
  }

  return {
    programId: data.programId,
    name: composedName,
    batchCode,
    intakeYear: batchCode ? data.intakeYear! : null,
    section: data.section || null,
    studyMode: data.studyMode ?? null,
    // FT-only — never trusted for a PT (or study-mode-less) class even if
    // somehow submitted, since period has no meaning there. classSchema
    // already requires it whenever studyMode is FT.
    period: data.studyMode === "FT" ? (data.period ?? null) : null,
    currentSemesterNumber: data.currentSemesterNumber ?? null,
    roomId: data.roomId || null,
  };
}

// Pre-checked before create/update (not caught via the DB's unique
// constraint after the fact) so the error can name the conflict directly —
// same pattern as every other duplicate guard in this app. The composed
// name already encodes batchCode+section+studyMode, so this single check
// covers the "batchCode+section+studyMode must be unique" rule too.
async function assertNoDuplicateName(
  programId: string,
  name: string,
  excludeId?: string
) {
  const existing = await prisma.class.findFirst({
    where: {
      programId,
      name,
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
  });
  if (existing) {
    throw new Error(`A class named "${name}" already exists in this program.`);
  }
}

export async function createClass(input: ClassInput) {
  await requirePermission("structure.manage");
  const data = classSchema.parse(input);
  const composed = await composeClassData(data);
  await assertNoDuplicateName(composed.programId, composed.name);
  await prisma.class.create({ data: composed });
  revalidatePath("/admin/structure");
}

export async function updateClass(id: string, input: ClassInput) {
  await requirePermission("structure.manage");
  const data = classSchema.parse(input);
  const composed = await composeClassData(data);
  await assertNoDuplicateName(composed.programId, composed.name, id);
  await prisma.class.update({ where: { id }, data: composed });
  revalidatePath("/admin/structure");
}

export async function deactivateClass(id: string) {
  await requirePermission("structure.manage");
  await prisma.class.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  revalidatePath("/admin/structure");
}

export async function reactivateClass(id: string) {
  await requirePermission("structure.manage");
  await prisma.class.update({
    where: { id },
    data: { deletedAt: null },
  });
  revalidatePath("/admin/structure");
}

export interface BulkPeriodPreviewRow {
  classId: string;
  className: string;
  currentPeriod: "MORNING" | "AFTERNOON" | null;
  // Whether any TimetableSlot already exists under this class's course
  // assignments — changing period never moves existing sessions, so this
  // is what drives the "existing timetable" warning shown before confirm.
  hasExistingSlots: boolean;
}

// Read-only preview for the Bulk Update Period dialog — resolves each
// selected class's CURRENT period and whether it already has scheduled
// TimetableSlots, so the confirm step can show both before anything is
// written. Re-verifies FT-only itself rather than trusting the client's
// own filtering (the picker only ever offers FT classes, but this is the
// same "never trust round-tripped ids" defense every other bulk action in
// this app applies) — a non-FT id is simply excluded, not an error, since
// nothing about this call has written anything yet.
export async function previewBulkClassPeriodUpdate(
  classIds: string[]
): Promise<BulkPeriodPreviewRow[]> {
  await requirePermission("structure.manage");
  const ids = [...new Set(classIds)].filter(Boolean);
  if (ids.length === 0) return [];

  const [classes, slotRows] = await Promise.all([
    prisma.class.findMany({
      where: { id: { in: ids }, studyMode: "FT" },
      select: { id: true, name: true, period: true },
      orderBy: { name: "asc" },
    }),
    prisma.timetableSlot.findMany({
      where: { assignment: { classId: { in: ids } } },
      select: { assignment: { select: { classId: true } } },
    }),
  ]);

  const classIdsWithSlots = new Set(slotRows.map((s) => s.assignment.classId));

  return classes.map((c) => ({
    classId: c.id,
    className: c.name,
    currentPeriod: c.period,
    hasExistingSlots: classIdsWithSlots.has(c.id),
  }));
}

export interface BulkPeriodUpdateResult {
  updated: number;
  // Requested ids that turned out not to be a real, currently FT class by
  // the time this ran (out of scope / became PT / deleted since preview)
  // — excluded from the write, never force-updated, same defense-in-depth
  // every other confirm action in this app applies.
  skipped: number;
}

// Writes the new period to every selected FT class in ONE statement
// (updateMany — a single atomic UPDATE...WHERE IN, not a per-row loop
// inside $transaction, since there's no per-row branching needed here).
// Re-verifies FT-only itself, exactly like the preview above — never
// trusts the client's own filtering, even though the real dialog only
// ever gets here via previewBulkClassPeriodUpdate's own FT-only result.
export async function bulkUpdateClassPeriod(
  input: BulkClassPeriodInput
): Promise<BulkPeriodUpdateResult> {
  const admin = await requirePermission("structure.manage");
  const data = bulkClassPeriodSchema.parse(input);
  const ids = [...new Set(data.classIds)];

  const classes = await prisma.class.findMany({
    where: { id: { in: ids }, studyMode: "FT" },
    select: { id: true, name: true, period: true },
  });
  if (classes.length === 0) {
    throw new Error("None of the selected classes are eligible (FT only) for a period update.");
  }

  const eligibleIds = classes.map((c) => c.id);
  await prisma.class.updateMany({
    where: { id: { in: eligibleIds } },
    data: { period: data.newPeriod },
  });

  // Old -> new period per class, plus who did it — requirement 5.
  await audit({
    userId: admin.id,
    action: "CLASS_PERIOD_BULK_UPDATED",
    entity: "Class",
    oldValue: {
      classes: classes.map((c) => ({ classId: c.id, className: c.name, period: c.period })),
    },
    newValue: {
      newPeriod: data.newPeriod,
      classes: classes.map((c) => ({ classId: c.id, className: c.name })),
    },
  });

  revalidatePath("/admin/structure");

  return { updated: classes.length, skipped: ids.length - classes.length };
}
