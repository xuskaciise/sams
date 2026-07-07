import { redirect } from "next/navigation";

export default async function StudentAccountsRedirect({
  searchParams,
}: {
  searchParams: Promise<{ classId?: string }>;
}) {
  const { classId } = await searchParams;
  const params = new URLSearchParams({ tab: "student-accounts" });
  if (classId) params.set("classId", classId);
  redirect(`/admin/students?${params.toString()}`);
}
