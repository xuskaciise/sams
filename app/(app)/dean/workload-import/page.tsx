import { WorkloadImportPanel } from "../../admin/workload-import/panel";

// Same panel as /admin/workload-import — see that file's comment for why
// the scoping (dean_departments, via classDeanWhere inside
// previewWorkloadImport/confirmWorkloadImport/previewAutoTimetableBatch/
// confirmAutoTimetableBatch) is safe regardless of which route rendered
// it. Same "one implementation, two routes" pattern as Daily Log and
// Timetable — a Dean only ever sees/creates assignments and generates
// timetables for classes in their own faculty.
export default async function DeanWorkloadImportPage() {
  return <WorkloadImportPanel />;
}
