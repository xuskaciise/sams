import { redirect } from "next/navigation";

export default function SemestersRedirect() {
  redirect("/admin/calendar?tab=semesters");
}
