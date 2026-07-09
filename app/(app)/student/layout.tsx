import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth";

export default async function StudentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getSessionContext();
  if (!ctx || !ctx.permissions.has("results.view.own")) {
    redirect("/");
  }

  return <>{children}</>;
}
