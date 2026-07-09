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
  type LucideIcon,
} from "lucide-react";
import type { Role } from "@prisma/client";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  roles?: Role[];
}

export const NAV_ITEMS: NavItem[] = [
  // DEAN gets its own "Dashboard" entry below (pointing straight at /dean)
  // instead of this generic one, so the sidebar never shows two
  // identically-labeled rows.
  {
    label: "Dashboard",
    href: "/",
    icon: LayoutDashboard,
    roles: ["ADMIN", "LECTURER", "STUDENT"],
  },
  {
    label: "My Courses",
    href: "/lecturer",
    icon: ClipboardList,
    roles: ["LECTURER"],
  },
  {
    label: "Reports",
    href: "/lecturer/reports",
    icon: BarChart3,
    roles: ["LECTURER"],
  },
  {
    label: "My Courses",
    href: "/student",
    icon: ClipboardList,
    roles: ["STUDENT"],
  },
  {
    label: "Dashboard",
    href: "/dean",
    icon: LayoutDashboard,
    roles: ["DEAN"],
  },
  {
    label: "Ownership Transfer",
    href: "/dean/transfers",
    icon: ArrowRightLeft,
    roles: ["DEAN"],
  },
  {
    label: "Close Semester",
    href: "/dean/close-semester",
    icon: Lock,
    roles: ["DEAN"],
  },
  {
    label: "Reports",
    href: "/dean/reports",
    icon: BarChart3,
    roles: ["DEAN"],
  },
  {
    label: "Academic Structure",
    href: "/admin/structure",
    icon: Building2,
    roles: ["ADMIN"],
  },
  {
    label: "Academic Calendar",
    href: "/admin/calendar",
    icon: CalendarClock,
    roles: ["ADMIN"],
  },
  {
    label: "Curriculum",
    href: "/admin/curriculum",
    icon: BookOpen,
    roles: ["ADMIN"],
  },
  {
    label: "Students",
    href: "/admin/students",
    icon: UserPlus,
    roles: ["ADMIN"],
  },
  { label: "Users", href: "/admin/users", icon: Users, roles: ["ADMIN"] },
  {
    label: "Audit Logs",
    href: "/admin/audit-logs",
    icon: ScrollText,
    roles: ["ADMIN"],
  },
];
