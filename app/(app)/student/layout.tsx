import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth";
import type { PermissionKey } from "@/lib/permissions";

// Any student-tool permission grants entry to the section; each page and
// every Server Action still checks its own specific permission — same
// "outer gate is cosmetic" pattern as admin/dean layouts.
const STUDENT_SECTION_PERMISSIONS: PermissionKey[] = [
  "results.view.own",
  "dailylog.view.own",
  "timetable.view.own",
];

export default async function StudentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getSessionContext();
  if (
    !ctx ||
    !STUDENT_SECTION_PERMISSIONS.some((p) => ctx.permissions.has(p))
  ) {
    redirect("/");
  }

  return <>{children}</>;
}
