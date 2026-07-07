import { redirect } from "next/navigation";

export default function AcademicYearsRedirect() {
  redirect("/admin/calendar?tab=academic-years");
}
