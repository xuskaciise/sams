# SAMS — Student Assessment Management System

University Continuous Assessment (CA) management system. Replaces Excel-based
activity marks management. NOT an LMS, NOT an SIS — no online exams, no
attendance, no course materials, no messaging.

Full specification: `docs/spec.md`
Database schema: `prisma/schema.prisma` (source of truth — do not restructure
without explicit approval)

## Stack

- Next.js (App Router, Server Actions — no separate API routes unless necessary)
- TypeScript, strict mode
- Prisma ORM + PostgreSQL (Neon: pooled DATABASE_URL + DIRECT_URL for migrations)
- Custom auth: argon2id password hashing + database sessions (httpOnly, secure,
  sameSite=lax cookies). NO Supabase, NO NextAuth, NO Clerk.
- Zod for all input validation
- Tailwind CSS

## Roles (enum, fixed — never add a roles table)

ADMIN, DEAN, LECTURER, STUDENT

## NON-NEGOTIABLE SECURITY RULES

These are academic-integrity rules. Never relax them, even "temporarily":

1. **Admin can NEVER create, edit, publish, or delete assessments, marks, or
   results.** Admin is read-only on all academic data. Admin manages users,
   departments, programs, courses, classes, semesters, assignments, enrollments.
2. **Only the assessment owner (created_by) may edit it.** Other lecturers —
   even those assigned to the same course — may not.
3. **Only DEAN may transfer assessment ownership** (record in
   ownership_transfers with mandatory reason) and close semesters.
4. **Students see ONLY published results.** Draft results must never reach the
   client for a student session — filter in the query, not in the UI.
5. **Published results are never edited directly.** Changes go through the
   correction flow: create a ResultCorrection row (old_mark, new_mark,
   mandatory reason), set is_corrected = true. Corrections are append-only —
   never update or delete correction rows.
6. **Every Server Action starts with an authorization check** (requireRole +
   ownership/status checks from lib/auth.ts). No exceptions. Prisma bypasses
   RLS, so the app layer is the ONLY security boundary.
7. **Audit log every critical action:** login (success + failure), assessment
   create/edit, marks entry/update, publish, correction, ownership transfer,
   enrollment transfer, user create/deactivate.
8. **Soft delete only** (deleted_at) for academic data. Never hard-delete
   assessments, results, enrollments, or audit logs.

## Business rules

- Marks are DECIMAL(5,2). Valid range: 0 <= mark <= assessment.maximum_marks.
  Enforce in Zod AND rely on DB constraint.
- mark is nullable: ABSENT / EXEMPT results have null mark + attendance_status.
- Results link to StudentCourseEnrollment (NOT directly to student+class).
  Class transfer = old enrollment status TRANSFERRED + new enrollment; marks
  stay with the old enrollment and are linked/carried per system setting.
- Groups are course-assignment-level, not assessment-level: a StudentGroup
  belongs to a LecturerCourseAssignment and is reusable across every
  assessment in that course/class/semester. Managed from a standalone
  "Groups" page, not from inside an assessment.
- A student can belong to at most ONE group per course assignment (DB unique
  constraint on group_members: assignment_id + student_id).
- Group grading is SNAPSHOT model: "same mark" copies the mark to every
  member's result row in one transaction. group_id on the result is a
  reference only. Individual overrides within a group are allowed.
- Deleting a group or changing its members must never affect already-saved
  results (snapshot model holds). Renaming/removing members is always
  allowed; deleting a group entirely is blocked if any PUBLISHED result
  still references it.
- Assessment status flow: DRAFT -> PUBLISHED -> CLOSED. Closed = immutable,
  no corrections. Only DEAN closes (via semester close).
- Result entry uses optimistic locking: compare updated_at before writing;
  reject stale writes with a clear error.
- No CA total cap — lecturers decide their own assessment weights.
- Login rate limiting: 5 failed attempts -> lock 15 minutes (locked_until).
- Admin creates all accounts with temp password; must_change_password forces
  reset on first login. There is NO public signup and NO email flows in V1.
- No notifications in V1.
- Student registration is separate from account creation. Registering a
  student (student_no, full_name, gender, class) creates only a Student
  row — user_id is nullable, so a student can exist with no login. Accounts
  are generated later, per class or per student, from the standalone
  "Student Accounts" page: username = student_no, a synthetic email
  (student_no@students.sams.local) satisfies the User.email constraint,
  random temp password, must_change_password = true. Temp passwords are
  shown once (CSV download + print view) and never persisted in plaintext.
- User.username is unique and always set: staff = their email,
  students = their student_no. Login accepts EITHER username or email
  (case-insensitive), resolved with a single OR query.
- Admin -> Users manages ADMIN/DEAN/LECTURER accounts only. STUDENT
  accounts are managed exclusively through Student Registration + Student
  Accounts.

## Conventions

- Server Actions live in `app/**/actions.ts`, always "use server", always
  validate input with Zod, always auth-check first.
- Auth helpers in `lib/auth.ts`: getCurrentUser(), requireRole(...roles),
  requireAssessmentOwner(assessmentId), requireAssignmentOwner(assignmentId).
- Audit logging via a single helper `lib/audit.ts` — never inline raw
  prisma.auditLog.create calls in feature code.
- Prisma client singleton in `lib/db.ts`. Never import Prisma in client
  components.
- Money/marks math: never use JS floats for mark totals — use Prisma Decimal.
- All dates stored UTC.

## Testing

- Every authorization rule above gets a test (Vitest). Priority order:
  student-cannot-see-drafts, admin-cannot-touch-results,
  non-owner-cannot-edit, published-requires-correction-flow.

## Workflow for Claude Code

- Read this file and docs/spec.md before large tasks.
- Work in small phases; do not scaffold unrequested modules.
- After schema changes: prisma migrate dev, then update seed script.
- Commit after each working phase.

## UI & Design

- Use shadcn/ui components for ALL UI — never raw HTML buttons/inputs
- Layout: sidebar navigation (collapsible on mobile) + top bar with 
  user name, role badge, and logout
- Look: clean academic dashboard — white cards on gray-50 background, 
  rounded-lg, subtle borders, no heavy shadows
- Accent color: indigo-600 for primary actions; red only for 
  destructive actions; green for Published, amber for Draft status badges
- Typography: text-sm default, font-semibold page titles, 
  muted-foreground for secondary text
- Tables: shadcn Table with sticky header, zebra rows, right-aligned 
  numeric columns (marks)
- Forms: shadcn Form + Zod, inline validation errors, toast on success
- Every page: consistent page header (title + description + 
  primary action button on the right)
- All pages must be responsive (usable on a phone)

## Roadmap & Progress

Phase 1: Foundation (schema, migration, seed) — DONE
Phase 2: Auth (login, sessions, rate limiting, forced pw change) — DONE
Phase 3: Admin module (users, departments, programs, years, semesters, 
  courses, classes, assignments, enrollments) — DONE
Phase 4: Lecturer module (assessments CRUD, result entry grid, group 
  grading, draft/publish, corrections) — DONE
Phase 4.1: Groups redesigned as course-level/reusable across assessments 
  (standalone Groups page, migration of existing groups, deletion guard 
  for published results) — DONE
Phase 3.1: Student registration split from account creation (nullable 
  Student.user_id + full_name + gender, User.username, login by 
  username-or-email, standalone Student Registration + Student Accounts 
  pages with bulk/per-student generation and password reset) — DONE
Phase 5: Student module (dashboard, published results, totals) — NOT STARTED
Phase 6: Dean module + Reports (ownership transfer, close semester, 
  course/class reports) — NOT STARTED

Update this section whenever a phase is completed.
