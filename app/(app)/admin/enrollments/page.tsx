import { redirect } from "next/navigation";

export default async function EnrollmentsRedirect({
  searchParams,
}: {
  searchParams: Promise<{ classId?: string; courseId?: string }>;
}) {
  const { classId, courseId } = await searchParams;
  const params = new URLSearchParams({ tab: "enrollments" });
  if (classId) params.set("classId", classId);
  if (courseId) params.set("courseId", courseId);
  redirect(`/admin/students?${params.toString()}`);
}
