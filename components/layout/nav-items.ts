import {
  LayoutDashboard,
  Users,
  Building2,
  CalendarClock,
  BookOpen,
  UserPlus,
  ClipboardList,
  ArrowRightLeft,
  BarChart3,
  ScrollText,
  Star,
  LayoutGrid,
  NotebookPen,
  CalendarDays,
  Landmark,
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
    label: "My Timetable",
    href: "/lecturer/timetable",
    icon: CalendarDays,
    permissions: ["timetable.view.own"],
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
    label: "My Schedule",
    href: "/student/timetable",
    icon: CalendarDays,
    permissions: ["timetable.view.own"],
  },
  {
    label: "Ownership Transfer",
    href: "/dean/transfers",
    icon: ArrowRightLeft,
    permissions: ["ownership.transfer"],
  },
  {
    label: "Reports",
    href: "/dean/reports",
    icon: BarChart3,
    permissions: ["reports.view.all"],
  },
  {
    label: "Daily Log",
    href: "/dean/daily-log",
    icon: NotebookPen,
    permissions: ["dailylog.view"],
  },
  {
    label: "Timetable",
    href: "/dean/timetable",
    icon: CalendarDays,
    permissions: ["timetable.view"],
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
  {
    label: "Daily Log",
    href: "/admin/daily-log",
    icon: NotebookPen,
    permissions: ["dailylog.view"],
  },
  {
    label: "Timetable",
    href: "/admin/timetable",
    icon: CalendarDays,
    permissions: ["timetable.view"],
  },
  // campus.manage/room.manage are independent of timetable.manage/
  // timetable.view — a user granted only one of these two shows this
  // link without needing Timetable access, and vice versa.
  {
    label: "Campuses",
    href: "/admin/campuses",
    icon: Landmark,
    permissions: ["campus.manage", "room.manage"],
  },
];
