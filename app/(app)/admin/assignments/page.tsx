import { redirect } from "next/navigation";

export default function AssignmentsRedirect() {
  redirect("/admin/curriculum?tab=assignments");
}
