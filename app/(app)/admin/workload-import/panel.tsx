import { prisma } from "@/lib/db";
import { getSessionContext } from "@/lib/auth";
import { classDeanWhere } from "@/lib/dean-scope";
import { PageHeader } from "@/components/layout/page-header";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { getShiftOptionsForGenerator } from "./generator-data";
import { getScopeFlags } from "./actions";
import { WorkloadImportClient } from "./workload-import-client";
import {
  ClassWorkloadImportClient,
  type WorkloadImportClassOption,
} from "./class-workload-import-client";

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

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Workload Import & Auto-Timetable"
        description="Import course workload from Excel to create lecturer-course assignments, then optionally auto-generate a timetable for them."
      />
      <Tabs defaultValue="class">
        <TabsList>
          <TabsTrigger value="class">By Class (Recommended)</TabsTrigger>
          <TabsTrigger value="bulk">Bulk Import (Advanced)</TabsTrigger>
        </TabsList>
        <TabsContent value="class" className="pt-4">
          <ClassWorkloadImportClient
            classes={classes}
            canGenerate={canGenerate}
            shifts={shifts}
          />
        </TabsContent>
        <TabsContent value="bulk" className="pt-4">
          <WorkloadImportClient canGenerate={canGenerate} shifts={shifts} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
