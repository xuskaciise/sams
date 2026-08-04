import { getSessionContext } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { getShiftOptionsForGenerator } from "./generator-data";
import { WorkloadImportClient } from "./workload-import-client";

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
  const shifts = canGenerate ? await getShiftOptionsForGenerator() : [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Workload Import & Auto-Timetable"
        description="Import course workload from Excel to create lecturer-course assignments, then optionally auto-generate a timetable for them."
      />
      <WorkloadImportClient canGenerate={canGenerate} shifts={shifts} />
    </div>
  );
}
