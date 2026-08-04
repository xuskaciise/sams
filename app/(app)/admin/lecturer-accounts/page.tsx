import { redirect } from "next/navigation";

export default async function LecturerAccountsRedirect({
  searchParams,
}: {
  searchParams: Promise<{ departmentId?: string }>;
}) {
  const { departmentId } = await searchParams;
  const params = new URLSearchParams({ tab: "lecturer-accounts" });
  if (departmentId) params.set("departmentId", departmentId);
  redirect(`/admin/lecturers?${params.toString()}`);
}
