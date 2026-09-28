import { StudentTransferPanel } from "../../admin/student-transfer/panel";

// Same panel as /admin/student-transfer — the panel and both actions
// re-derive the caller's faculty scope from their role, so a Dean can only
// transfer a student whose CURRENT class and TARGET class are both inside
// their own dean_departments.
export default async function DeanStudentTransferPage({
  searchParams,
}: {
  searchParams: Promise<{ studentId?: string }>;
}) {
  const { studentId } = await searchParams;
  return <StudentTransferPanel studentId={studentId} />;
}
