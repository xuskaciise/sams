// The single source of truth for permission keys. The DB `permissions`
// table mirrors this list (migration seeds it; prisma/seed.ts re-syncs it
// idempotently). Adding a permission = add it here + seed, never a raw
// insert in feature code.

export const PERMISSION_CATEGORIES = [
  "Academic Structure",
  "Academic Calendar",
  "Curriculum",
  "Students",
  "Users & Security",
  "Assessments",
  "Results",
  "Reports",
  "Timetable",
] as const;

export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

export interface PermissionDef {
  key: string;
  description: string;
  category: PermissionCategory;
}

export const PERMISSIONS = [
  // Academic structure (was ADMIN-only)
  {
    key: "structure.manage",
    description: "Manage departments, programs, and classes",
    category: "Academic Structure",
  },
  // Academic calendar — all ADMIN. semester.close moved here from DEAN
  // (global calendar action, not a Dean tool).
  {
    key: "calendar.manage",
    description: "Manage academic years and semesters",
    category: "Academic Calendar",
  },
  {
    key: "semester.open",
    description: "Run the Open Semester wizard (advance classes, bulk-assign, auto-enroll)",
    category: "Academic Calendar",
  },
  {
    key: "semester.close",
    description: "Close the active semester (locks all its assessments)",
    category: "Academic Calendar",
  },
  // Curriculum (was ADMIN-only)
  {
    key: "curriculum.manage",
    description: "Manage courses, course plans, and lecturer-course assignments",
    category: "Curriculum",
  },
  // Students (was ADMIN-only)
  {
    key: "students.manage",
    description: "Register students, manage student accounts, bulk import, transfer students",
    category: "Students",
  },
  {
    key: "enrollments.manage",
    description: "Manage enrollment exceptions (add, drop, restore, transfer)",
    category: "Students",
  },
  // Users & security (was ADMIN-only)
  {
    key: "user.manage",
    description: "Create and edit staff accounts, reset passwords, import lecturers",
    category: "Users & Security",
  },
  {
    key: "user.delete",
    description: "Deactivate and reactivate staff accounts",
    category: "Users & Security",
  },
  {
    key: "roles.manage",
    description: "Manage roles, role permissions, and per-user permission overrides",
    category: "Users & Security",
  },
  {
    key: "audit.view",
    description: "View the audit log",
    category: "Users & Security",
  },
  // Assessments (was LECTURER-only; ownership checks apply on top)
  {
    key: "assessment.view.own",
    description: "View own course assignments and assessments (lecturer module)",
    category: "Assessments",
  },
  {
    key: "assessment.create",
    description: "Create assessments under own course assignments",
    category: "Assessments",
  },
  {
    key: "assessment.edit",
    description: "Edit or delete own draft assessments",
    category: "Assessments",
  },
  {
    key: "assessment.publish",
    description: "Publish own draft assessments",
    category: "Assessments",
  },
  {
    key: "groups.manage",
    description: "Manage student groups under own course assignments",
    category: "Assessments",
  },
  // Results (enter/correct were LECTURER + ownership; view.own was STUDENT)
  {
    key: "results.enter",
    description: "Enter or update marks on own draft assessments",
    category: "Results",
  },
  {
    key: "results.correct",
    description: "Correct published results on own assessments (correction flow)",
    category: "Results",
  },
  {
    key: "results.view.own",
    description: "View own published results (student module)",
    category: "Results",
  },
  // Reports
  {
    key: "reports.view.own",
    description: "View and export reports for own course assignments",
    category: "Reports",
  },
  {
    key: "reports.view.all",
    description: "View and export reports across all courses, classes, and students",
    category: "Reports",
  },
  // Dean administrative
  {
    key: "ownership.transfer",
    description: "Transfer assessment ownership between lecturers",
    category: "Users & Security",
  },
  // Faculty Daily Log — notes/leave notices/problems against a faculty
  // (Department). WHAT (these keys) vs WHERE (dean_departments, see
  // lib/dean-scope.ts) is the same split as every other dean-scoped
  // feature: ADMIN acts on any faculty, DEAN only their own.
  {
    key: "dailylog.create",
    description: "Create daily log entries (leave notices, problems, notes)",
    category: "Users & Security",
  },
  {
    key: "dailylog.view",
    description: "View daily log entries",
    category: "Users & Security",
  },
  // A narrower read-only variant, shared by LECTURER and STUDENT: neither
  // ever sees the faculty log itself (no dailylog.view), only
  // LEAVE_NOTICE entries that name THEM specifically — a lecturer via
  // relatedLecturerId, a student via relatedStudentId. Same "view.own"
  // shape as results.view.own/reports.view.own/assessment.view.own.
  {
    key: "dailylog.view.own",
    description: "View own leave notices (lecturer or student)",
    category: "Users & Security",
  },
  // Class Timetable — scheduling of course + lecturer + day + time + room
  // per class/semester. Same WHAT/WHERE split as every other dean-scoped
  // feature: timetable.manage/view are held by both ADMIN and DEAN, and
  // dean_departments (via assignmentDeanWhere) is the WHERE boundary,
  // re-derived from the caller's role every call.
  {
    key: "timetable.manage",
    description: "Create, edit, and delete timetable slots and rooms",
    category: "Timetable",
  },
  {
    key: "timetable.view",
    description: "View the timetable across classes",
    category: "Timetable",
  },
  // Narrower read-only variant, shared by LECTURER and STUDENT — same
  // "view.own" shape as dailylog.view.own: never the full timetable, only
  // the slots relevant to their own courses.
  {
    key: "timetable.view.own",
    description: "View own timetable (lecturer or student)",
    category: "Timetable",
  },
  // Campus/Room infrastructure is split OUT of timetable.manage into its
  // own keys, deliberately ADMIN-only (not granted to DEAN): a Dean
  // schedules classes into rooms at their faculty (timetable.manage,
  // scoped), but doesn't manage the physical campus/room inventory
  // itself — that's centrally administered, same "ADMIN manages
  // structure, DEAN operates within it" split as everywhere else in this
  // app (e.g. structure.manage vs. Dean's narrower tools).
  {
    key: "campus.manage",
    description: "Create, edit, and deactivate campuses",
    category: "Timetable",
  },
  {
    key: "room.manage",
    description: "Create, edit, and deactivate rooms (including bulk add)",
    category: "Timetable",
  },
  // Shifts are reusable time-of-day templates (a data-entry convenience,
  // not a scheduling constraint) — same ADMIN-only split as campus.manage
  // /room.manage and for the same reason: centrally administered, not a
  // per-faculty concern. Reading/using shifts to fill a session's time
  // needs no separate key — any timetable.manage holder (ADMIN or a
  // scoped DEAN) can see and pick from the shift list, same as the room
  // picker; only creating/editing/deactivating shifts requires this key.
  {
    key: "shift.manage",
    description: "Create, edit, and deactivate shift time templates",
    category: "Timetable",
  },
] as const satisfies readonly PermissionDef[];

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key) as PermissionKey[];

export const SYSTEM_ROLES = ["ADMIN", "DEAN", "LECTURER", "STUDENT"] as const;
export type SystemRoleName = (typeof SYSTEM_ROLES)[number];

// EXACTLY the access each enum role effectively had before the RBAC
// migration — post-migration behavior must be identical. In particular
// ADMIN holds ZERO assessment/results keys (security rule 1: admin can
// never touch academic data) and STUDENT holds only results.view.own.
export const DEFAULT_ROLE_GRANTS: Record<SystemRoleName, PermissionKey[]> = {
  ADMIN: [
    "structure.manage",
    "calendar.manage",
    "semester.open",
    "semester.close",
    "curriculum.manage",
    "students.manage",
    "enrollments.manage",
    "user.manage",
    "user.delete",
    "roles.manage",
    "audit.view",
    "dailylog.create",
    "dailylog.view",
    "timetable.manage",
    "timetable.view",
    "campus.manage",
    "room.manage",
    "shift.manage",
  ],
  DEAN: [
    "ownership.transfer",
    "reports.view.all",
    "dailylog.create",
    "dailylog.view",
    "timetable.manage",
    "timetable.view",
  ],
  LECTURER: [
    "assessment.view.own",
    "assessment.create",
    "assessment.edit",
    "assessment.publish",
    "groups.manage",
    "results.enter",
    "results.correct",
    "reports.view.own",
    "dailylog.view.own",
    "timetable.view.own",
  ],
  STUDENT: ["results.view.own", "dailylog.view.own", "timetable.view.own"],
};

export const SYSTEM_ROLE_DESCRIPTIONS: Record<SystemRoleName, string> = {
  ADMIN:
    "Manages users, academic structure, enrollment, and the academic calendar (including closing semesters); logs faculty daily-log entries for any faculty — read-only on all academic data (assessments, marks, results).",
  DEAN: "Transfers assessment ownership, views all reports, and logs daily-log entries for their own faculty.",
  LECTURER:
    "Creates and publishes assessments, enters and corrects marks — own course assignments only.",
  STUDENT: "Views own published results only.",
};
