import { redirect } from "next/navigation";

export default function RoomsRedirect() {
  redirect("/admin/campuses?tab=rooms");
}
