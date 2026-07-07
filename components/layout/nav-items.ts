import {
  LayoutDashboard,
  ShieldCheck,
  Users,
  Building2,
  GraduationCap,
  CalendarRange,
  CalendarClock,
  BookOpen,
  School,
  Link2,
  UserCheck,
  UserPlus,
  KeyRound,
  ClipboardList,
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
  { label: "Admin", href: "/admin", icon: ShieldCheck, roles: ["ADMIN"] },
  { label: "Users", href: "/admin/users", icon: Users, roles: ["ADMIN"] },
  {
    label: "Departments",
    href: "/admin/departments",
    icon: Building2,
    roles: ["ADMIN"],
  },
  {
    label: "Programs",
    href: "/admin/programs",
    icon: GraduationCap,
    roles: ["ADMIN"],
  },
  {
    label: "Academic Years",
    href: "/admin/academic-years",
    icon: CalendarRange,
    roles: ["ADMIN"],
  },
  {
    label: "Semesters",
    href: "/admin/semesters",
    icon: CalendarClock,
    roles: ["ADMIN"],
  },
  { label: "Courses", href: "/admin/courses", icon: BookOpen, roles: ["ADMIN"] },
  { label: "Classes", href: "/admin/classes", icon: School, roles: ["ADMIN"] },
  {
    label: "Assignments",
    href: "/admin/assignments",
    icon: Link2,
    roles: ["ADMIN"],
  },
  {
    label: "Enrollments",
    href: "/admin/enrollments",
    icon: UserCheck,
    roles: ["ADMIN"],
  },
  {
    label: "Students",
    href: "/admin/students",
    icon: UserPlus,
    roles: ["ADMIN"],
  },
  {
    label: "Student Accounts",
    href: "/admin/student-accounts",
    icon: KeyRound,
    roles: ["ADMIN"],
  },
];
