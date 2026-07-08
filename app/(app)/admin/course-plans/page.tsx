import { redirect } from "next/navigation";

export default async function CoursePlansRedirect({
  searchParams,
}: {
  searchParams: Promise<{ classId?: string; semesterNumber?: string }>;
}) {
  const { classId, semesterNumber } = await searchParams;
  const params = new URLSearchParams({ tab: "course-plans" });
  if (classId) params.set("classId", classId);
  if (semesterNumber) params.set("semesterNumber", semesterNumber);
  redirect(`/admin/curriculum?${params.toString()}`);
}
