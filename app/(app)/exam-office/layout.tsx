import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth";

// exam.records.view is the whole section boundary — a single-purpose,
// read-only report with no sub-pages, same "one permission gates one
// section" shape as /admin/whatsapp.
export default async function ExamOfficeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getSessionContext();
  if (!ctx || !ctx.permissions.has("exam.records.view")) {
    redirect("/");
  }

  return <>{children}</>;
}
