import { redirect } from "next/navigation";

export default async function CoursePlansRedirect({
  searchParams,
}: {
  searchParams: Promise<{ classId?: string }>;
}) {
  const { classId } = await searchParams;
  const params = new URLSearchParams({ tab: "course-plans" });
  if (classId) params.set("classId", classId);
  redirect(`/admin/curriculum?${params.toString()}`);
}
