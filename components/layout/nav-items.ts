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
  MessageCircle,
  FileSpreadsheet,
  GraduationCap,
  Send,
  Shuffle,
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
  // For features sharing one implementation across an /admin and /dean
  // route (Daily Log, Timetable, Workload Import) under the SAME
  // permission key(s) — ADMIN and DEAN both hold them, so without this a
  // session would otherwise show the link twice. When set, a DEAN session
  // resolves to this href instead of `href`, mirroring the same
  // `roleNames.includes("DEAN")` precedence the underlying panels already
  // use server-side.
  deanHref?: string;
  // Same idea as deanHref, for a THIRD route sharing one implementation
  // with ADMIN/DEAN (Send Notification — held by ADMIN, DEAN, AND
  // LECTURER all at once). Precedence in app-shell.tsx is DEAN >
  // LECTURER > default href, matching admin/notifications/send/
  // recipients.ts's own resolveSenderScope precedence exactly, so the
  // nav link and the actual scoping behavior always agree.
  lecturerHref?: string;
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
  // Lecturer's own read-only weekly teaching schedule (WeeklyGrid, no
  // edit/build — that stays Admin/Dean-only). Coexists with the
  // dashboard's "Today's Schedule" widget: this is the full week, that's
  // a quick daily glance. Gated on assessment.view.own — the
  // LECTURER-signature key (same as "My Courses"/"My Reports" above), NOT
  // timetable.view.own, which STUDENT also holds and would surface this
  // lecturer route in a student's sidebar (mirror of the student "My
  // Schedule" gate below). The page itself is timetable.view.own-scoped
  // data (getMyTimetableForLecturer) and self-gates too.
  {
    label: "My Schedule",
    href: "/lecturer/timetable",
    icon: CalendarDays,
    permissions: ["assessment.view.own"],
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
  // Gated on results.view.own (the student-portal signature key, same as
  // "Results"/"Semester Overview" above) — NOT timetable.view.own, which
  // LECTURER also holds and would wrongly surface this student route in a
  // lecturer's sidebar. A default STUDENT holds both keys, so students
  // still see it.
  {
    label: "My Schedule",
    href: "/student/timetable",
    icon: CalendarDays,
    permissions: ["results.view.own"],
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
  // Lecturer registration + account generation (phone-based login) —
  // its own section, same "gets its own hub, not a Users tab" pattern as
  // Students. Gated on user.manage, same permission Users itself uses for
  // staff account management (Lecturer accounts are staff accounts too;
  // this only moved WHERE lecturer creation happens, not which key covers
  // it — see CLAUDE.md's "Lecturer registration split" business rule).
  {
    label: "Lecturers",
    href: "/admin/lecturers",
    icon: GraduationCap,
    permissions: ["user.manage"],
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
    deanHref: "/dean/daily-log",
    icon: NotebookPen,
    permissions: ["dailylog.view"],
  },
  {
    label: "Timetable",
    href: "/admin/timetable",
    deanHref: "/dean/timetable",
    icon: CalendarDays,
    permissions: ["timetable.view"],
  },
  // Bulk multi-class room shuffle (chains/cycles) — coexists with the
  // Classes page's single-class "Change room" and pairwise "Swap rooms".
  // timetable.manage (ADMIN + DEAN); a Dean is scoped to their own
  // faculty's classes, re-derived from role in the panel + every action.
  {
    label: "Room Reassignment",
    href: "/admin/room-reassignment",
    deanHref: "/dean/room-reassignment",
    icon: Shuffle,
    permissions: ["timetable.manage"],
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
  {
    label: "WhatsApp",
    href: "/admin/whatsapp",
    icon: MessageCircle,
    permissions: ["whatsapp.manage", "notification.templates.manage"],
  },
  // Manual/ad-hoc sending — held by ADMIN, DEAN, and LECTURER at once
  // (unlike WhatsApp above, which is ADMIN-only), so this is the first
  // nav entry needing all three of href/deanHref/lecturerHref. Each
  // route renders the exact same shared panel; see
  // admin/notifications/send/panel.tsx and CLAUDE.md's WhatsApp
  // Notifications section.
  {
    label: "Send Notification",
    href: "/admin/notifications/send",
    deanHref: "/dean/notifications/send",
    lecturerHref: "/lecturer/notifications/send",
    icon: Send,
    permissions: ["notification.send.manual"],
  },
  // Single entry point for the whole Excel-driven workload import + optional
  // sequential auto-timetable generation workflow — see CLAUDE.md's
  // "Workload Excel import + auto-timetable generation" business rule.
  // Either key alone is enough to see the link (a caller could import
  // workload without ever generating, or hold generate without import —
  // though in practice generation is only reachable from a fresh import's
  // own success dialog).
  {
    label: "Workload Import",
    href: "/admin/workload-import",
    deanHref: "/dean/workload-import",
    icon: FileSpreadsheet,
    permissions: ["workload.import", "timetable.generate"],
  },
];
