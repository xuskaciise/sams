import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth";
import type { PermissionKey } from "@/lib/permissions";

// Any admin-category permission grants entry to the section shell; each
// page's panel and every Server Action still checks its own specific
// permission — this layout is just the outer gate.
const ADMIN_SECTION_PERMISSIONS: PermissionKey[] = [
  "structure.manage",
  "calendar.manage",
  "semester.open",
  "curriculum.manage",
  "students.manage",
  "enrollments.manage",
  "user.manage",
  "user.delete",
  "roles.manage",
  "audit.view",
];

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getSessionContext();
  if (!ctx || !ADMIN_SECTION_PERMISSIONS.some((p) => ctx.permissions.has(p))) {
    redirect("/");
  }

  return <>{children}</>;
}
