import { StudentTransferPanel } from "./panel";

export default async function StudentTransferPage({
  searchParams,
}: {
  searchParams: Promise<{ studentId?: string }>;
}) {
  const { studentId } = await searchParams;
  return <StudentTransferPanel studentId={studentId} />;
}
