import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth";
import { AppShell } from "@/components/layout/app-shell";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getSessionContext();
  if (!ctx) {
    redirect("/login");
  }

  return (
    <AppShell
      user={{
        fullName: ctx.user.fullName,
        roleNames: ctx.roleNames,
        permissions: Array.from(ctx.permissions),
      }}
    >
      {children}
    </AppShell>
  );
}
