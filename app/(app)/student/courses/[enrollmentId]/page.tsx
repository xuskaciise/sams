import { redirect } from "next/navigation";

// This route moved to /student/results/[enrollmentId] as part of the
// results-page redesign. Kept as a thin redirect so any old links/bookmarks
// keep working, matching the redirect convention used elsewhere (e.g. the
// old /dean?tab= links).
export default async function LegacyStudentCourseDetailRedirect({
  params,
}: {
  params: Promise<{ enrollmentId: string }>;
}) {
  const { enrollmentId } = await params;
  redirect(`/student/results/${enrollmentId}`);
}
