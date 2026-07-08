import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";

export default async function StudentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user || user.role !== "STUDENT") {
    redirect("/");
  }

  return <>{children}</>;
}
