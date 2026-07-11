import {
  LayoutDashboard,
  Users,
  Building2,
  CalendarClock,
  BookOpen,
  UserPlus,
  ClipboardList,
  ArrowRightLeft,
  Lock,
  BarChart3,
  ScrollText,
  Star,
  LayoutGrid,
  type LucideIcon,
} from "lucide-react";
import type { PermissionKey } from "@/lib/permissions";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  // Visible if the user holds ANY of these permissions. Omitted = visible
  // to every authenticated user. The server-side page/action guards are
  // the real boundary — this only controls what the sidebar shows.
  permissions?: PermissionKey[];
}

export const NAV_ITEMS: NavItem[] = [
  // One Dashboard entry for everyone: "/" itself redirects DEAN -> /dean
  // and STUDENT -> /student, so no per-role dashboard rows are needed.
  {
    label: "Dashboard",
    href: "/",
    icon: LayoutDashboard,
  },
  {
    label: "My Courses",
    href: "/lecturer",
    icon: ClipboardList,
    permissions: ["assessment.view.own"],
  },
  {
    label: "My Reports",
    href: "/lecturer/reports",
    icon: BarChart3,
    permissions: ["reports.view.own"],
  },
  {
    label: "Results",
    href: "/student/results",
    icon: Star,
    permissions: ["results.view.own"],
  },
  {
    label: "Semester Overview",
    href: "/student/overview",
    icon: LayoutGrid,
    permissions: ["results.view.own"],
  },
  {
    label: "Ownership Transfer",
    href: "/dean/transfers",
    icon: ArrowRightLeft,
    permissions: ["ownership.transfer"],
  },
  {
    label: "Close Semester",
    href: "/dean/close-semester",
    icon: Lock,
    permissions: ["semester.close"],
  },
  {
    label: "Reports",
    href: "/dean/reports",
    icon: BarChart3,
    permissions: ["reports.view.all"],
  },
  {
    label: "Academic Structure",
    href: "/admin/structure",
    icon: Building2,
    permissions: ["structure.manage"],
  },
  {
    label: "Academic Calendar",
    href: "/admin/calendar",
    icon: CalendarClock,
    permissions: ["calendar.manage"],
  },
  {
    label: "Curriculum",
    href: "/admin/curriculum",
    icon: BookOpen,
    permissions: ["curriculum.manage"],
  },
  {
    label: "Students",
    href: "/admin/students",
    icon: UserPlus,
    permissions: ["students.manage", "enrollments.manage"],
  },
  {
    label: "Users",
    href: "/admin/users",
    icon: Users,
    permissions: ["user.manage", "user.delete", "roles.manage"],
  },
  {
    label: "Audit Logs",
    href: "/admin/audit-logs",
    icon: ScrollText,
    permissions: ["audit.view"],
  },
];
