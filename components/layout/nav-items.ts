import {
  LayoutDashboard,
  Users,
  Building2,
  CalendarClock,
  BookOpen,
  UserPlus,
  ClipboardList,
  GraduationCap,
  BarChart3,
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
  { label: "Dashboard", href: "/", icon: LayoutDashboard },
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
    label: "Dean",
    href: "/dean",
    icon: GraduationCap,
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
];
