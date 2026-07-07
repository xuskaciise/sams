import { redirect } from "next/navigation";

export default function CoursesRedirect() {
  redirect("/admin/curriculum?tab=courses");
}
