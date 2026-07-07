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
- Enrollment is AUTOMATIC, not manual data entry:
  1. Registering a student (or moving one to a new class) auto-creates
     ACTIVE enrollments for every course assigned to that class in any
     currently-active semester (LecturerCourseAssignment where
     semester.is_active = true). Existing enrollments are skipped, not
     duplicated.
  2. Creating a new LecturerCourseAssignment auto-enrolls every current
     student of that class into that course, for that assignment's
     semester.
  3. Both run inside a transaction and audit-log each created row as
     AUTO_ENROLLED (see lib/enrollment.ts — shared by student
     registration, class transfer, and assignment creation).
  Admin -> Enrollments is a management view, not a data-entry form:
  filter by class/course, see status, and handle exceptions only —
  drop, restore, or transfer. A small "Add manually" action remains for
  edge cases (e.g. a student joining one course from a different class).
- ClassCoursePlan is a reusable curriculum template: each class's planned
  course list (classId + courseId, unique pair). No semester number on
  the plan itself — class names already encode their level (e.g.
  "CMS 1 FT" = semester-1 level), so the same plan is reused every time
  that class's semester is opened. Managed from the standalone
  "Course Plans" page, with a "copy plan from another class" action.
- Semester lifecycle: only ONE semester can be Active at a time, globally
  (not per academic year) — the Semesters page's "Open semester" wizard is
  the only way to activate one. It: (1) shows a warning naming any
  semester(s) that will be deactivated, (2) lists every class that has a
  course plan, each deselectable (e.g. a class not running this term),
  (3) requires a lecturer pick per planned course, (4) on confirm, in one
  transaction: deactivates other active semesters, activates this one,
  creates a LecturerCourseAssignment per selected class/course/lecturer
  (skipping any that already exist), and auto-enrolls each class's
  students (reusing lib/enrollment.ts). Audit-logged as SEMESTER_OPENED,
  plus AUTO_ENROLLED per enrollment. The Assignments page remains for
  mid-semester exceptions (single assignment add/change) — the wizard
  does not replace it.
- Class Promotion moves students between classes at semester end (e.g.
  CMS 1 FT -> CMS 2 FT): admin picks a source class, a target class in
  the SAME program (existing or newly created inline), and a checklist
  of the source class's current students (default all checked — uncheck
  repeaters/leavers who should stay behind). Confirming updates ONLY
  Student.class_id for the checked students, in one transaction.
  Existing StudentCourseEnrollment rows are never touched — they keep
  their original class_id/semester_id as the historical record, and
  marks stay linked to those enrollments exactly as before. Promotion
  creates NO enrollments for the target class; those come from "Open
  semester" once its course plan is set up. Warns (but allows, with an
  explicit acknowledgement checkbox) if the current active semester
  isn't closed yet. Audit-logged as CLASS_PROMOTED with the student
  count and both class ids.
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
- Bulk import (admin-only) exists for Students, Courses, and Lecturers via
  one reusable flow: `components/admin/bulk-import-dialog.tsx` (generic
  Upload -> Preview -> Confirm dialog) driven by shared helpers in
  `lib/import/` (`parse.ts` for SheetJS parsing + 5MB/2000-row limits,
  `template.ts` for xlsx template generation, `preview.ts` for the
  duplicate-in-file/already-exists/OK row classification, `types.ts` for
  the shared shapes) plus a `bulk-import-actions.ts` per entity
  (students/courses/users dirs) that supplies the template/preview/confirm
  Server Actions. Preview writes nothing — it parses server-side and
  returns a per-row status (OK / DUPLICATE_IN_FILE / ALREADY_EXISTS /
  ERROR with an exact reason); every row sharing a duplicate key is
  flagged, not just the 2nd+ occurrence, since there's no safe way to
  guess which is authoritative. Confirm imports ONLY the OK rows the
  client already computed, in one transaction, re-checking for conflicts
  immediately before the transaction (same catch-and-continue-is-unsafe
  rule as below — never discovered via a failed create). Students import
  creates Student rows only and auto-enrolls via `lib/enrollment.ts`
  exactly like manual registration; Courses import upserts nothing, only
  creates, uppercasing codes like the manual form; Lecturers import
  creates User(role=LECTURER)+Lecturer per row with a temp password,
  shown once after confirm (CSV download + print, same pattern as Student
  Accounts). Every import is audit-logged as `BULK_IMPORT` with entity
  type, filename, and row counts; lecturer imports additionally audit
  `USER_CREATED` per row. Re-uploading an already-imported file is
  naturally idempotent — the second preview marks every row
  ALREADY_EXISTS, so confirm has zero OK rows to act on.

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
- Never skip an expected duplicate inside a `$transaction` with try/catch
  around a unique-constraint violation (P2002) and `continue`. Postgres
  aborts the WHOLE transaction on the first failed statement — every
  statement after it fails too ("current transaction is aborted"), even
  though the JS catch swallows the error and the loop looks like it's
  continuing normally. Instead, query for what already exists and filter
  it out BEFORE issuing any create — see `lib/enrollment.ts`'s
  auto-enroll helpers, `copyPlanFromClass`, and `openSemester` for the
  pattern. A single create/update outside a loop (nothing else follows it
  in that transaction) is fine to catch normally.
- Growable-list pickers (anything backed by a table row that isn't a tiny
  fixed list — classes, courses, lecturers, students) use
  `components/ui/searchable-select.tsx`, not the plain shadcn `Select`.
  Same props shape everywhere (`value`, `onValueChange(value: string)`,
  `items: {value, label, keywords?}[]`, `placeholder`, `disabled`): a
  Popover + Command combobox with substring search, keyboard nav, a
  checkmark on the selected item, and an empty-state message built in.
  Student pickers show `"{studentNo} — {fullName}"` so search matches
  either. Keep truly small fixed lists (gender, semester, status filters)
  as plain `Select` — search would just add noise there. It isn't
  RHF-`FormControl`-wrapped like `SelectTrigger` is (it's a single
  self-contained component, not a composable trigger/content pair), so
  drop it straight into `FormItem` next to `FormLabel`/`FormMessage`
  without a `FormControl` wrapper.
- Admin nav is 4 grouped hub pages (each a tabbed route, tab state in the
  `tab` query param) instead of one link per sub-resource:
  `/admin/structure` (Departments | Programs | Classes),
  `/admin/calendar` (Academic Years | Semesters),
  `/admin/curriculum` (Courses | Course Plans | Assignments),
  `/admin/students` (Students | Student Accounts | Enrollments |
  Class Promotion — this hub reuses the `/admin/students` path itself,
  since "Students" is both the hub and one of its own tabs).
  `/admin/users` stays standalone (staff accounts only). Each sub-resource
  keeps its own `page.tsx` route too, but only as a thin redirect to its
  new tab URL (preserving any of its own query params, e.g.
  `classId`/`sourceClassId`) — the real fetch-and-render logic lives in a
  sibling `panel.tsx` (a named-export async Server Component) that the hub
  page imports directly. Never delete a sub-resource's `actions.ts`,
  `schema.ts`, or `*-client.tsx` — hubs only ever change WHICH route
  renders that existing logic, never the logic itself. When adding a new
  sub-resource to an existing hub, remember to point its `revalidatePath`
  calls and any internal `router.push` navigation at the hub path (with
  `tab=`), not its own old standalone path.

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
Phase 3.2: Enrollment changed from manual to automatic (auto-enroll on 
  student registration/class transfer and on new course assignment, 
  Enrollments page redesigned as a filtered management/exceptions view) 
  — DONE
Phase 3.3: Semester Course Plan (curriculum template) + semester lifecycle 
  (ClassCoursePlan model, standalone Course Plans page with copy-from-class, 
  Semesters "Open semester" wizard that bulk-creates assignments + 
  auto-enrolls from the plan, global single-active-semester rule) — DONE
Phase 3.4: Class Promotion (move students from e.g. CMS 1 FT to CMS 2 FT 
  at semester end — checklist-based, target class same program, 
  Student.class_id only, enrollments/marks untouched) — DONE
Phase 3.5: Admin nav reorganization — consolidated ~15 sidebar links into 
  4 tabbed hub pages (Academic Structure, Academic Calendar, Curriculum, 
  Students) plus standalone Users; tab state in the URL; old sub-resource 
  URLs redirect to their new tab (query params preserved); no logic/schema 
  changes, existing page components reused as-is inside panel.tsx files 
  — DONE
Phase 3.6: Bulk import (Excel/CSV) for Students, Courses, and Lecturers — 
  one reusable Upload -> Preview -> Confirm dialog (lib/import/ helpers + 
  bulk-import-actions.ts per entity), template download, per-row 
  validation with exact error reasons, duplicate-in-file and 
  already-exists-in-DB detection (skip, never silently update), 
  auto-enrollment on student import, temp-password list for lecturer 
  import, BULK_IMPORT audit logging — DONE
Phase 5: Student module (dashboard, published results, totals) — NOT STARTED
Phase 6: Dean module + Reports (ownership transfer, close semester, 
  course/class reports) — NOT STARTED

Update this section whenever a phase is completed.
