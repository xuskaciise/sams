import { redirect } from "next/navigation";

export default function DepartmentsRedirect() {
  redirect("/admin/structure?tab=departments");
}
