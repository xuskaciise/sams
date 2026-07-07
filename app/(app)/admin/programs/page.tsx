import { redirect } from "next/navigation";

export default function ProgramsRedirect() {
  redirect("/admin/structure?tab=programs");
}
