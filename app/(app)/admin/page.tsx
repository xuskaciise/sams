import Link from "next/link";
import {
  Users,
  Building2,
  GraduationCap,
  CalendarRange,
  CalendarClock,
  BookOpen,
  School,
  Link2,
  UserCheck,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

const ADMIN_SECTIONS: {
  label: string;
  href: string;
  description: string;
  icon: LucideIcon;
}[] = [
  {
    label: "Users",
    href: "/admin/users",
    description: "Create accounts and manage roles.",
    icon: Users,
  },
  {
    label: "Departments",
    href: "/admin/departments",
    description: "Manage academic departments.",
    icon: Building2,
  },
  {
    label: "Programs",
    href: "/admin/programs",
    description: "Manage programs within departments.",
    icon: GraduationCap,
  },
  {
    label: "Academic Years",
    href: "/admin/academic-years",
    description: "Manage academic years.",
    icon: CalendarRange,
  },
  {
    label: "Semesters",
    href: "/admin/semesters",
    description: "Manage semesters within academic years.",
    icon: CalendarClock,
  },
  {
    label: "Courses",
    href: "/admin/courses",
    description: "Manage courses offered.",
    icon: BookOpen,
  },
  {
    label: "Classes",
    href: "/admin/classes",
    description: "Manage classes within programs.",
    icon: School,
  },
  {
    label: "Assignments",
    href: "/admin/assignments",
    description: "Assign lecturers to courses and classes.",
    icon: Link2,
  },
  {
    label: "Enrollments",
    href: "/admin/enrollments",
    description: "Enroll, drop, and transfer students.",
    icon: UserCheck,
  },
];

export default function AdminPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Admin"
        description="Manage users and academic structure. Admin is read-only on all academic results."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ADMIN_SECTIONS.map((section) => {
          const Icon = section.icon;
          return (
            <Link key={section.href} href={section.href}>
              <Card className="transition-colors hover:bg-muted/40">
                <CardHeader>
                  <Icon className="size-5 text-primary" />
                  <CardTitle>{section.label}</CardTitle>
                  <CardDescription>{section.description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
