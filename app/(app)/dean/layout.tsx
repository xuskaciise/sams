import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";

export default async function DeanLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user || user.role !== "DEAN") {
    redirect("/");
  }

  return <>{children}</>;
}
