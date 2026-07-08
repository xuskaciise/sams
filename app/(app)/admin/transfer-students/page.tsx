import { redirect } from "next/navigation";

export default async function TransferStudentsRedirect({
  searchParams,
}: {
  searchParams: Promise<{ sourceClassId?: string }>;
}) {
  const { sourceClassId } = await searchParams;
  const params = new URLSearchParams({ tab: "transfer-students" });
  if (sourceClassId) params.set("sourceClassId", sourceClassId);
  redirect(`/admin/students?${params.toString()}`);
}
