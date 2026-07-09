import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth";
import type { PermissionKey } from "@/lib/permissions";

// assessment.view.own covers the module's read pages; reports.view.own
// alone also suffices (the Reports page is inside this section). Every
// mutation still checks its own permission + ownership.
const LECTURER_SECTION_PERMISSIONS: PermissionKey[] = [
  "assessment.view.own",
  "reports.view.own",
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
