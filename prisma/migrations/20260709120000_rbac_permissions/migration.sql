-- RBAC migration: replaces the fixed Role enum with role/permission
-- tables. Data-preserving: every user's enum role is copied into a
-- user_roles row BEFORE the column is dropped, and the 4 system roles
-- are seeded with exactly the permissions that role effectively had
-- before this migration — post-migration behavior is identical.

-- CreateEnum
CREATE TYPE "OverrideEffect" AS ENUM ('GRANT', 'DENY');

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_permission_overrides" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,
    "effect" "OverrideEffect" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_permission_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");
CREATE UNIQUE INDEX "role_permissions_role_id_permission_id_key" ON "role_permissions"("role_id", "permission_id");
CREATE UNIQUE INDEX "user_roles_user_id_role_id_key" ON "user_roles"("user_id", "role_id");
CREATE INDEX "user_roles_role_id_idx" ON "user_roles"("role_id");
CREATE UNIQUE INDEX "user_permission_overrides_user_id_permission_id_key" ON "user_permission_overrides"("user_id", "permission_id");

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the 4 system roles (mirrors lib/permissions.ts)
INSERT INTO "roles" ("id", "name", "description", "is_system", "updated_at") VALUES
  (gen_random_uuid()::text, 'ADMIN', 'Manages users, academic structure, and enrollment — read-only on all academic data (assessments, marks, results).', true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'DEAN', 'Transfers assessment ownership, closes semesters, views all reports.', true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'LECTURER', 'Creates and publishes assessments, enters and corrects marks — own course assignments only.', true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'STUDENT', 'Views own published results only.', true, CURRENT_TIMESTAMP);

-- Seed the permission catalog (mirrors lib/permissions.ts)
INSERT INTO "permissions" ("id", "key", "description", "category") VALUES
  (gen_random_uuid()::text, 'structure.manage', 'Manage departments, programs, and classes', 'Academic Structure'),
  (gen_random_uuid()::text, 'calendar.manage', 'Manage academic years and semesters', 'Academic Calendar'),
  (gen_random_uuid()::text, 'semester.open', 'Run the Open Semester wizard (advance classes, bulk-assign, auto-enroll)', 'Academic Calendar'),
  (gen_random_uuid()::text, 'semester.close', 'Close the active semester (locks all its assessments)', 'Academic Calendar'),
  (gen_random_uuid()::text, 'curriculum.manage', 'Manage courses, course plans, and lecturer-course assignments', 'Curriculum'),
  (gen_random_uuid()::text, 'students.manage', 'Register students, manage student accounts, bulk import, transfer students', 'Students'),
  (gen_random_uuid()::text, 'enrollments.manage', 'Manage enrollment exceptions (add, drop, restore, transfer)', 'Students'),
  (gen_random_uuid()::text, 'user.manage', 'Create and edit staff accounts, reset passwords, import lecturers', 'Users & Security'),
  (gen_random_uuid()::text, 'user.delete', 'Deactivate and reactivate staff accounts', 'Users & Security'),
  (gen_random_uuid()::text, 'roles.manage', 'Manage roles, role permissions, and per-user permission overrides', 'Users & Security'),
  (gen_random_uuid()::text, 'audit.view', 'View the audit log', 'Users & Security'),
  (gen_random_uuid()::text, 'assessment.view.own', 'View own course assignments and assessments (lecturer module)', 'Assessments'),
  (gen_random_uuid()::text, 'assessment.create', 'Create assessments under own course assignments', 'Assessments'),
  (gen_random_uuid()::text, 'assessment.edit', 'Edit or delete own draft assessments', 'Assessments'),
  (gen_random_uuid()::text, 'assessment.publish', 'Publish own draft assessments', 'Assessments'),
  (gen_random_uuid()::text, 'groups.manage', 'Manage student groups under own course assignments', 'Assessments'),
  (gen_random_uuid()::text, 'results.enter', 'Enter or update marks on own draft assessments', 'Results'),
  (gen_random_uuid()::text, 'results.correct', 'Correct published results on own assessments (correction flow)', 'Results'),
  (gen_random_uuid()::text, 'results.view.own', 'View own published results (student module)', 'Results'),
  (gen_random_uuid()::text, 'reports.view.own', 'View and export reports for own course assignments', 'Reports'),
  (gen_random_uuid()::text, 'reports.view.all', 'View and export reports across all courses, classes, and students', 'Reports'),
  (gen_random_uuid()::text, 'ownership.transfer', 'Transfer assessment ownership between lecturers', 'Users & Security');

-- Grant each system role exactly its pre-migration effective access
-- (mirrors DEFAULT_ROLE_GRANTS in lib/permissions.ts)
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "roles" r
JOIN "permissions" p ON (
  (r.name = 'ADMIN' AND p.key IN (
    'structure.manage', 'calendar.manage', 'semester.open',
    'curriculum.manage', 'students.manage', 'enrollments.manage',
    'user.manage', 'user.delete', 'roles.manage', 'audit.view'
  ))
  OR (r.name = 'DEAN' AND p.key IN (
    'ownership.transfer', 'semester.close', 'reports.view.all'
  ))
  OR (r.name = 'LECTURER' AND p.key IN (
    'assessment.view.own', 'assessment.create', 'assessment.edit',
    'assessment.publish', 'groups.manage', 'results.enter',
    'results.correct', 'reports.view.own'
  ))
  OR (r.name = 'STUDENT' AND p.key IN ('results.view.own'))
);

-- Migrate every user's enum role to a user_roles row (BEFORE dropping
-- the column). Every enum value has a matching system role by name, so
-- this loses no one.
INSERT INTO "user_roles" ("id", "user_id", "role_id")
SELECT gen_random_uuid()::text, u.id, r.id
FROM "users" u
JOIN "roles" r ON r.name = u.role::text;

-- DropIndex / DropColumn / DropEnum — only after the data is migrated
DROP INDEX "users_role_idx";
ALTER TABLE "users" DROP COLUMN "role";
DROP TYPE "Role";
