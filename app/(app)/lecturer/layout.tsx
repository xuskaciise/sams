import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth";
import type { PermissionKey } from "@/lib/permissions";

// assessment.view.own covers the module's read pages; reports.view.own
// alone also suffices (the Reports page is inside this section). Every
// mutation still checks its own permission + ownership.
// timetable.view.own is deliberately NOT listed: STUDENT also holds it,
// so admitting it here would let a student reach /lecturer/* by URL. A
// default LECTURER always holds assessment.view.own, so this doesn't
// lock any real lecturer out of /lecturer/timetable (which also
// self-gates on assessment.view.own). Mirror of the student/layout.tsx
// fix that dropped timetable.view.own for the same reason.
const LECTURER_SECTION_PERMISSIONS: PermissionKey[] = [
  "assessment.view.own",
  "reports.view.own",
  "notification.send.manual",
];

export default async function LecturerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getSessionContext();
  if (
    !ctx ||
    !LECTURER_SECTION_PERMISSIONS.some((p) => ctx.permissions.has(p))
  ) {
    redirect("/");
  }

  return <>{children}</>;
}
