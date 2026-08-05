import { prisma } from "@/lib/db";
import { getSessionContext } from "@/lib/auth";
import { classDeanWhere } from "@/lib/dean-scope";
import { PageHeader } from "@/components/layout/page-header";
import { getShiftOptionsForGenerator } from "./generator-data";
import { getScopeFlags } from "./actions";
import type { WorkloadImportClassOption } from "./class-workload-import-client";
import type { WorkloadImportSemesterOption } from "./semester-workload-import-client";
import { WorkloadImportTabsClient } from "./workload-import-tabs-client";

// Classes eligible for the per-class flow: a current semester level set
// AND at least one course actually planned at that exact level — the same
// two-step "candidate list, then filter by real plan rows at the class's
// OWN level" approach the Open Semester wizard's classesWithPlans already
// uses (Prisma can't express "coursePlans some where semesterNumber =
// this row's own currentSemesterNumber" as a single relational filter).
// A class failing either check would only ever produce an empty/blocked
// template, so it's simply not offered here — the "By Class" picker can
// never land on a dead end.
async function getWorkloadImportClasses(
  userId: string
): Promise<WorkloadImportClassOption[]> {
  const { isDean, departmentIds } = await getScopeFlags(userId);

  const classes = await prisma.class.findMany({
    where: {
      deletedAt: null,
      currentSemesterNumber: { not: null },
      ...(isDean ? classDeanWhere(departmentIds) : {}),
    },
    orderBy: { name: "asc" },
  });
  if (classes.length === 0) return [];

  const plans = await prisma.classCoursePlan.findMany({
    where: { classId: { in: classes.map((c) => c.id) } },
    select: { classId: true, semesterNumber: true },
  });
  const plannedCountByClassLevel = new Map<string, number>();
  for (const p of plans) {
    const key = `${p.classId}:${p.semesterNumber}`;
    plannedCountByClassLevel.set(key, (plannedCountByClassLevel.get(key) ?? 0) + 1);
  }

  return classes
    .map((c) => ({
      id: c.id,
      name: c.name,
      currentSemesterNumber: c.currentSemesterNumber,
      plannedCourseCount: plannedCountByClassLevel.get(`${c.id}:${c.currentSemesterNumber}`) ?? 0,
    }))
    .filter((c) => c.plannedCourseCount > 0);
}

// The per-semester-level flow's own eligible options are just an
// aggregation over the SAME already-filtered class list above (a class
// only ever reaches getWorkloadImportClasses's result if it has a
// current level AND a real plan at that level) — no second query needed,
// and it guarantees the two tabs can never disagree about which levels
// are usable.
function getSemesterNumberOptions(
  classes: WorkloadImportClassOption[]
): WorkloadImportSemesterOption[] {
  const classCountByLevel = new Map<number, number>();
  for (const c of classes) {
    if (c.currentSemesterNumber === null) continue;
    classCountByLevel.set(
      c.currentSemesterNumber,
      (classCountByLevel.get(c.currentSemesterNumber) ?? 0) + 1
    );
  }
  return [...classCountByLevel.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([semesterNumber, classCount]) => ({ semesterNumber, classCount }));
}

// workload.import and timetable.generate are independent keys (see
// lib/permissions.ts) — a caller could hold one without the other, e.g.
// import workload but always schedule manually. The page itself is gated
// on workload.import (see nav-items.ts / admin/layout.tsx); the "Continue
// to auto-generate timetable" step is only offered when the caller also
// holds timetable.generate, same "hide the controls, not the whole view"
// pattern as Campus/Room/Shift's manage-vs-view split. Shifts are
// pre-fetched here (unscoped, same as the Timetable page's own picker —
// it has no faculty affiliation in the schema) so the generator's
// shift-override UI doesn't need its own round trip. Room is NOT
// pre-fetched here — it's a class-registration property (Class.roomId,
// set under Academic Structure > Classes) the generator only ever READS,
// never picks, so it needs no room reference data of its own.
export async function WorkloadImportPanel() {
  const ctx = await getSessionContext();
  const canGenerate = ctx?.permissions.has("timetable.generate") ?? false;
  const [shifts, classes] = await Promise.all([
    canGenerate ? getShiftOptionsForGenerator() : Promise.resolve([]),
    getWorkloadImportClasses(ctx!.user.id),
  ]);
  const semesterNumberOptions = getSemesterNumberOptions(classes);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Workload Import & Auto-Timetable"
        description="Import course workload from Excel to create lecturer-course assignments, then optionally auto-generate a timetable for them."
      />
      <WorkloadImportTabsClient
        classes={classes}
        semesterNumberOptions={semesterNumberOptions}
        canGenerate={canGenerate}
        shifts={shifts}
      />
    </div>
  );
}
