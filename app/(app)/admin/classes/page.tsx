import { redirect } from "next/navigation";

export default function ClassesRedirect() {
  redirect("/admin/structure?tab=classes");
}
