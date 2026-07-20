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
  ],
  DEAN: ["ownership.transfer", "reports.view.all"],
  LECTURER: [
    "assessment.view.own",
    "assessment.create",
    "assessment.edit",
    "assessment.publish",
    "groups.manage",
    "results.enter",
    "results.correct",
    "reports.view.own",
  ],
  STUDENT: ["results.view.own"],
};

export const SYSTEM_ROLE_DESCRIPTIONS: Record<SystemRoleName, string> = {
  ADMIN:
    "Manages users, academic structure, enrollment, and the academic calendar (including closing semesters) — read-only on all academic data (assessments, marks, results).",
  DEAN: "Transfers assessment ownership and views all reports.",
  LECTURER:
    "Creates and publishes assessments, enters and corrects marks — own course assignments only.",
  STUDENT: "Views own published results only.",
};
