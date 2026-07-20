import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth";
import type { PermissionKey } from "@/lib/permissions";

// Any dean-tool permission grants entry to the section; each page and
// every Server Action still checks its own specific permission.
const DEAN_SECTION_PERMISSIONS: PermissionKey[] = [
  "ownership.transfer",
  "reports.view.all",
];

export default async function DeanLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getSessionContext();
  if (!ctx || !DEAN_SECTION_PERMISSIONS.some((p) => ctx.permissions.has(p))) {
    redirect("/");
  }

  return <>{children}</>;
}
