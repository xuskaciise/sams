import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";

export default async function LecturerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user || user.role !== "LECTURER") {
    redirect("/");
  }

  return <>{children}</>;
}
