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
- Classes model a real BATCH/COHORT structure, not a flat list: a class
  row is BATCH + SECTION + STUDY MODE (e.g. batchCode "CMS2518" + section
  "A" + studyMode "FT" -> display name "CMS2518-A-FT"). A batch is
  permanent — students never move between class rows for normal
  progression. What advances each term is Class.currentSemesterNumber
  (1..8), bumped by the "Open semester" wizard. `name` is auto-composed
  from batchCode+section+studyMode whenever all three are set; legacy/
  edge-case classes may keep a manually-typed `name` instead (all four
  batch fields are nullable for exactly this reason — an admin can leave
  them blank and fill them in later without being blocked).
- ClassCoursePlan is a reusable curriculum template, per semester level:
  a plan row is (classId + semesterNumber + courseId). A class recurs
  through semesterNumber 1..8 as its batch advances, so the same class
  can have a different planned course list at each level. Managed from
  the standalone "Course Plans" page (class picker + semester-level
  picker), with a "copy plan from another class" action scoped to the
  selected level.
- Semester lifecycle: only ONE semester can be Active at a time, globally
  (not per academic year) — the Semesters page's "Open semester" wizard is
  the only way to activate one, and it is now a 3-step flow:
  (1) **Advance** — every class with a semester number and a course plan
  gets a single "advance to next semester" checkbox, default-checked iff
  that class had a LecturerCourseAssignment in the semester being
  succeeded (unchecked just means "stay at the current level, still
  included below" — there is no separate include/exclude control). Warns
  per class if the semester being succeeded isn't closed yet.
  (2) **Assign** — for each class, shows the ClassCoursePlan rows at
  whatever semester level it resolves into (current, or +1 if advancing)
  and requires a lecturer pick per course.
  (3) **Confirm** — a summary, then in one transaction: deactivates other
  active semesters, activates this one, bumps currentSemesterNumber for
  advancing classes, creates a LecturerCourseAssignment per
  class/course/lecturer (skipping any that already exist), and
  auto-enrolls each class's students (reusing lib/enrollment.ts).
  Audit-logged as SEMESTER_OPENED, plus AUTO_ENROLLED per enrollment. The
  Assignments page remains for mid-semester exceptions (single assignment
  add/change, or the "Bulk assign" dialog below) — the wizard does not
  replace it.
- Add/Edit Semester picks a semester NUMBER (1 or 2 — a "Semester" dropdown,
  not free text), not a name — `name` ("Semester 1"/"Semester 2") is
  derived server-side from `semesterNumber`. This `semesterNumber` (one
  per academic year) is a completely different concept from
  `Class.currentSemesterNumber`/`ClassCoursePlan.semesterNumber` (1..8,
  a batch's level in its cycle) — same field name pattern, unrelated
  numbering scheme, never conflate them. An academic year can have at
  most one Semester 1 and one Semester 2: `createSemester`/
  `updateSemester` pre-check `(academicYearId, semesterNumber)` before
  writing (update excludes its own id) and throw `"This academic year
  already has Semester {n}."` directly — same
  thrown-message-not-generic-code pattern as the one-lecturer-per-
  course-class-semester conflict message. `semesterNumber` is nullable
  at the DB level (`@@unique([academicYearId, semesterNumber])`, and
  Postgres treats NULLs as distinct so any number of unmapped rows can
  coexist) purely for the migration that added it: existing semesters
  got backfilled by exact case/whitespace-insensitive name match
  ("Semester 1" -> 1, "Semester 2" -> 2), anything else was left null for
  an admin to set via Edit — the Edit form intentionally does NOT
  default an unset semester to "1", it leaves the dropdown empty so
  submitting without picking one fails validation.
- One lecturer per course+class+semester — LecturerCourseAssignment is
  unique on (courseId, classId, semesterId) alone, not lecturerId+that
  triple. No co-teaching in V1. Enforced everywhere an assignment can be
  created: the manual "Add Assignment" action pre-checks for an existing
  assignment and, if found, rejects with "This course in this class
  already has a lecturer (name). Use Dean ownership transfer to replace
  them."; the Open Semester wizard and the "Bulk assign" dialog (see
  below) both do the same pre-check per row before their transaction (a
  row already assigned to the SAME lecturer is skipped as normal — only
  a DIFFERENT lecturer is a conflict), collecting every conflict instead
  of failing the whole bulk operation on the first one found
  mid-transaction. There is no reassignment flow yet — swapping the
  lecturer on an existing assignment is Dean ownership transfer, Phase 6.
- "Bulk assign" (Assignments page, mid-semester/ad-hoc — NOT a replacement
  for the Open Semester wizard, which stays the tool for a normal
  semester open) lets an admin create many LecturerCourseAssignments at
  once from two entry directions that both flatten to the same
  {lecturerId, courseId, classId} rows before hitting the server:
  lecturer-first (one semester + one lecturer + rows of course/class) or
  class-first (one semester + one class + rows of course/lecturer).
  `bulkCreateAssignments` (app/(app)/admin/assignments/actions.ts) runs
  ONE transaction; rows that already exist, conflict with a different
  lecturer, or repeat a course+class within the same submitted batch are
  skipped with a per-row reason instead of failing the batch (same
  pre-check-before-any-create pattern as the wizard). Auto-enrollment
  fires per newly created assignment as usual. Audit-logged as
  BULK_ASSIGNED with requested/created/skipped counts; the client shows a
  "X created, Y skipped" summary with the reason per skipped row.
- Course pickers on the manual Assignments page (both "Add assignment" and
  "Bulk assign", both bulk directions) are scoped to the selected class,
  never a flat all-courses list — same source of truth the Open Semester
  wizard's Assign step already used (`ClassCoursePlan` at the class's
  CURRENT `currentSemesterNumber`; never +1, since these forms are for the
  semester already running, not for advancing a class). Class must be
  picked before the course field enables (placeholder reads "Select a
  class first" until then); picking a class (or, for the shared bulk
  Semester field, changing it) clears any now-stale course selection
  rather than leaving an invalid one in place. Courses already assigned a
  lecturer for the selected class+semester are excluded from the list
  entirely (the one-lecturer-per-course+class+semester rule), so the
  picker can't offer a course that would just bounce back with the
  "already has a lecturer" error. All of this lives in helper functions
  in `assignments-client.tsx` (`plansForClass`/`courseOptionsForClass`/
  `courseEmptyMessage`), reusing `assignments` and `classesWithPlans`
  already fetched in `panel.tsx` — no new queries needed. Fixed a real
  bug where the Course dropdown listed every course unfiltered, duplicates
  included; the duplicates turned out to be genuine duplicate `Course`
  rows in the data (same name, different ids — a data-quality issue from
  course creation/import, not a query join), so the picker also
  defensively dedupes by normalized name — the underlying duplicate rows
  themselves are NOT merged/cleaned up by this fix, that's a separate,
  bigger data-cleanup task if wanted.
- Transfer Students (`/admin/students?tab=transfer-students`) is an
  exceptions-only tool — repeaters, section changes — NOT how normal
  progression happens (that's the Open Semester wizard advancing
  currentSemesterNumber in place). Admin picks a source class, a target
  class in the SAME program (existing or newly created inline), and a
  checklist of the source class's current students (default all checked
  — uncheck students who should stay behind). Confirming updates ONLY
  Student.class_id for the checked students, in one transaction. Existing
  StudentCourseEnrollment rows are never touched — they keep their
  original class_id/semester_id as the historical record, and marks stay
  linked to those enrollments exactly as before. Creates NO enrollments
  for the target class; those come from "Open semester" once its course
  plan is set up. Warns (but allows, with an explicit acknowledgement
  checkbox) if the current active semester isn't closed yet.
  Audit-logged as STUDENTS_TRANSFERRED with the student count and both
  class ids.
- Groups are course-assignment-level, not assessment-level: a StudentGroup
  belongs to a LecturerCourseAssignment and is reusable across every
  assessment in that course/class/semester. Managed from a standalone
  "Groups" page, not from inside an assessment.
- A student can belong to at most ONE group per course assignment (DB unique
  constraint on group_members: assignment_id + student_id).
- Group grading is SNAPSHOT model: "same mark" copies the mark to every
  member's result row in one transaction. group_id on the result is a
  reference only. Individual overrides within a group are allowed.
- The lecturer's assessment Results tab (`app/(app)/lecturer/assessments/
  [assessmentId]/`) branches on `assessment.mode`, not just a "Groups" side
  tab: INDIVIDUAL renders the flat per-student `ResultGrid` as before;
  GROUP renders `GroupResultGrid` instead — it never lists individual
  students directly. Each `StudentGroup` is its own card with a
  same-mark/different-marks toggle (defaulting to "different" only when
  the group's existing marks already vary, otherwise "same"); switching
  the toggle TO "same" over a group with genuinely varying existing marks
  asks for confirmation first, since saving will overwrite them.
  "Same mark" keeps attendance per-member even though there's one shared
  mark input — a member marked ABSENT/EXEMPT still gets a null mark via
  `applySameMarkToGroup`, never the shared value. "Different marks" (and
  the read-only/published view for every group, regardless of its last
  toggle state — there's nothing left to "enter" once published) just
  reuses `ResultGrid` scoped to that group's members, passing its
  `groupId` through `saveResult` for the reference-only link, which is
  also how the existing per-row "Correct" flow keeps working for group
  members post-publish. Students enrolled but in no group for a GROUP
  assessment appear in a separate amber-flagged "ungrouped" `ResultGrid`
  section instead of being silently dropped.
- Deleting a group or changing its members must never affect already-saved
  results (snapshot model holds). Renaming/removing members is always
  allowed; deleting a group entirely is blocked if any PUBLISHED result
  still references it.
- Assessment status flow: DRAFT -> PUBLISHED -> CLOSED. Closed = immutable,
  no corrections. Only DEAN closes (via semester close).
- Dean module — standalone sidebar links, NOT a tabbed hub like the admin
  pages (`/dean` = Dashboard, `/dean/transfers` = Ownership Transfer,
  `/dean/close-semester` = Close Semester, `/dean/reports` = Reports; see
  the "Dean sidebar" bullet below for why this one diverges from the hub
  convention). Old `/dean?tab=transfers|close-semester|reports` links
  still work — `/dean/page.tsx` redirects them to the matching standalone
  route before rendering the dashboard, so nothing bookmarked or shared
  before this change breaks.
  - **Ownership transfer** (`dean/transfers/`): Dean picks an existing
    LecturerCourseAssignment (course+class+semester) and a new lecturer,
    with a mandatory reason. `transferOwnership` updates
    LecturerCourseAssignment.lecturerId to the new lecturer AND creates one
    ownership_transfers row (from/to/transferredBy/reason) per existing,
    non-deleted assessment under that assignment — in one transaction.
    Assessment.created_by is NEVER changed (kept as permanent history of
    who first made it); "who can currently edit" is instead resolved by
    `requireAssessmentOwner` (lib/auth.ts) as the most recent
    ownership_transfers row's `toLecturer` for that assessment, falling
    back to created_by when there's no transfer. This is what makes
    "Draft/published rules keep working for the new owner" true — DRAFT
    assessments become editable/publishable and PUBLISHED ones become
    correctable by the new lecturer immediately, with zero special-casing
    in saveResult/publishAssessment/correctResult/updateAssessment
    (they all already just call requireAssessmentOwner). The old lecturer
    loses access for free too: every "My Courses"/assignment-detail query
    is scoped through `lecturer: { userId }` on the assignment's CURRENT
    lecturerId, which the transfer already flipped. Blocked for an
    assignment in a closed semester (CLOSED_SEMESTER) or a no-op transfer
    to the same lecturer (SAME_LECTURER). Audited as
    OWNERSHIP_TRANSFERRED on the assignment, with the reason and affected
    assessment count.
  - **Close semester** (`dean/close-semester/`): targets ONLY the current
    active semester (there's only ever one). Confirmation dialog shows
    total assessment count and a specific warning for still-DRAFT ones —
    closing is one-way, so a draft closed here can never be published
    afterward and its marks never reach students. `closeSemester` sets
    Semester.is_closed = true and every DRAFT/PUBLISHED assessment in that
    semester to CLOSED, in one transaction (Semester.is_active is
    untouched — is_active/is_closed are orthogonal; the next Open Semester
    run is what eventually flips is_active). CLOSED immutability needs no
    per-action semester check anywhere: every write action already only
    allows exactly one prior status (saveResult/publishAssessment require
    DRAFT, correctResult requires PUBLISHED, applySameMarkToGroup requires
    DRAFT) — CLOSED matches none of them, so it's locked out automatically.
    The one gap this phase found and fixed: `createAssessment` had NO
    semester check at all, so a lecturer could create a brand-new DRAFT
    assessment under an already-closed semester's assignment — it now
    checks `assignment.semester.isClosed` first. Audited as
    SEMESTER_CLOSED with the closed count and the still-draft count at
    close time.
  - **Reports** (`dean/reports/`, read-only, Excel export via the `xlsx`
    package already used for bulk-import templates): per-course (one
    LecturerCourseAssignment — class performance avg/top/lowest plus a
    per-assessment avg/top/lowest breakdown), per-class (one class+
    semester — every course's average side by side, reusing the per-course
    calculation), per-student (full cross-semester enrollment history).
    All three are PUBLISHED-results-only, same rule as the student portal
    — a Dean report is not a backdoor into draft marks. A still-draft
    assessment still appears in the per-course breakdown (so the Dean can
    see grading isn't done) but contributes nothing to any average/top/
    lowest figure. A null (absent/exempt) published mark counts as 0
    toward earned, consistent with the student portal's semester-progress
    math. Report data crosses the Server Action boundary via `select`
    (not `include`) on the lecturer relation — no password hashes riding
    along in the payload just to show a name.
  - Dean is read-only on results everywhere else — no entry/edit/publish
    action exists under `/dean`, only the two administrative actions above
    plus the reports.
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
  Accounts. Each row's ... menu has Edit, Reset password, and Deactivate/
  Reactivate. Reset password (`resetUserPassword`) generates a fresh temp
  password the same way account creation does (random, argon2id-hashed,
  mustChangePw forced true, failedLogins/lockedUntil cleared), shown
  exactly once in the same temp-password dialog used right after creating
  a user (title switches between "User created" and "Password reset") —
  never persisted or logged in plaintext, only the hash is stored and only
  the email goes into the audit row (PASSWORD_RESET). An admin can't
  reset or deactivate their OWN row — both menu items are disabled there
  (`user.id === currentUserId`, passed down from `getCurrentUser()` in
  page.tsx) so the lockout risk never even reaches the server-side
  CANNOT_RESET_SELF/CANNOT_DEACTIVATE_SELF guards that back them up.
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
  Transfer Students — this hub reuses the `/admin/students` path itself,
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
- The sidebar itself is one config, not per-role hardcoded lists:
  `components/layout/nav-items.ts` exports a single `NAV_ITEMS: NavItem[]`
  (label, href, icon, optional `roles: Role[]`), and `AppShell` filters it
  by the session's role (`!item.roles || item.roles.includes(user.role)`)
  before rendering. Adding/removing a link for a role is a one-line change
  there — never hardcode a role-specific link list in a component. The
  generic "Dashboard" entry (href `/`) is shown to ADMIN/LECTURER/STUDENT;
  DEAN gets its own "Dashboard" entry (href `/dean`) instead, so the
  sidebar never shows two identically-labeled rows for the same role (DEAN
  is excluded from the generic entry's `roles` list for exactly this
  reason). Dean is the one section that does NOT use the admin hub/tab
  pattern — Ownership Transfer, Close Semester, and Reports are three
  separate top-level links/routes rather than tabs inside one page,
  because they're peer administrative tools a Dean jumps between directly,
  not sub-views of one resource the way e.g. Academic Years/Semesters are
  both "the calendar." The underlying `panel.tsx`/`actions.ts`/
  `*-client.tsx` per feature are unchanged from when it was a hub — only
  routing changed (each panel now renders under its own standalone
  `page.tsx` with its own `PageHeader`, and each feature's `revalidatePath`
  points at its own route instead of the old shared `/dean`).
- Every role's `/`-or-equivalent landing page is a real, read-only,
  data-backed dashboard, never a placeholder — ADMIN and LECTURER share
  the generic `app/(app)/page.tsx` (branches on `user.role` since they
  don't redirect away from `/`); STUDENT (`/student/page.tsx`) and DEAN
  (`/dean/page.tsx`) already redirect there from `/`, so their dashboards
  live at their own root page. ADMIN: student/lecturer/active-class counts
  + active semester name, a recent-audit-log table (last 8 `AuditLog`
  rows), quick links (Add user, Register student, Open semester,
  Assignments). LECTURER: assigned-course count, a table of DRAFT
  assessments still needing to be published (title, course/class, a
  direct "Enter results" link per row) — scoped through
  `assignment: { lecturer: { userId } }`, the same ownership pattern used
  everywhere else in the lecturer module. STUDENT: added a "Latest
  published mark" card next to the existing class/active-semester/
  courses-with-progress content — the single most recent PUBLISHED
  `AssessmentResult` across ANY semester, scoped through
  `enrollment: { studentId }` (`getStudentDashboardData` in
  `student/queries.ts`). DEAN: active semester name + Open/Closed status
  badge, open-assessment count and unpublished-draft count for the active
  semester, quick links to the three tool pages. All four are pure reads —
  no Server Actions, no mutations — matching every other "dashboard" in
  this app.
- Table conventions: any table that can grow large uses a shared toolkit
  instead of a bespoke filter bar — `lib/pagination.ts`
  (`resolvePageParams(searchParams, defaultPageSize?)` turns raw
  `page`/`pageSize` search params into `{page, pageSize, skip, take}` for
  Prisma, `buildPageMeta` computes `from`/`to`/`totalPages`), the client
  hook `lib/use-url-table-state.ts` (`useUrlTableState(defaultPageSize?)`
  reads `page`/`pageSize`/`q`/arbitrary filter keys from the URL and
  exposes `setPage`/`setPageSize`/`setSearch`/`setFilter`, all pushing to
  the URL via `router.push` so refresh/back/shareable links work), plus
  two presentational components: `components/ui/table-pagination.tsx`
  (page-size Select, "Showing X-Y of Z", prev/next) and
  `components/ui/table-search-input.tsx` (debounced 350ms search box).
  `TablePagination`/`TableSearchInput` are fully controlled (`page`,
  `pageSize`, `total`, `value`, `onChange`/`onPageChange` props) so they
  work both URL-driven (server-paginated: panel.tsx does
  `resolvePageParams` + `findMany`/`count` with `skip`/`take`, page
  fetched fresh from the DB) and locally-controlled (client-side
  pagination of an in-memory array with plain `useState`, used for
  report tables whose data arrives via an on-demand Server Action call
  rather than a page-load fetch — e.g. lecturer/dean Reports). Server-
  paginated so far: Assignments, Courses, Students, Enrollments, Users,
  Audit Logs (new `/admin/audit-logs` page, nav-scoped to ADMIN,
  default page size 25 instead of the usual 10 — a log table warrants a
  bigger default). `useUrlTableState.setFilter(key, "")` DELETES that
  URL param (empty string means "no filter"); base-ui's `Select`/
  `SelectItem` throws on an empty-string item `value`, so `Select`-based
  filters (Courses status, Users role/status, Audit Logs entity) use a
  non-empty `"all"` sentinel item and translate `value === "all" ? "" :
  value` at the `onValueChange` call site, while `SearchableSelect`-based
  filters (Assignments' Class/Course/Lecturer, Students'/Enrollments'
  Class/Course/Status) pass `""` straight through since that component's
  underlying `CommandItem` search-match value is built from
  `label`+`keywords`, not `item.value`. Assignments' Semester filter is
  the one 3-state exception: URL param absent -> defaults to the active
  semester; explicit `"all"` -> no semester filter; any other value ->
  filters to exactly that semester (see `ALL_SEMESTERS_VALUE` in
  `admin/assignments/panel.tsx`). Small fixed-size lists (Departments,
  Programs, Semesters, Academic Years, Classes, Course Plans, Transfer
  Students, Student Accounts, Groups) intentionally were NOT converted —
  their row counts don't warrant it.

## Testing

- Every authorization rule above gets a test (Vitest). Priority order:
  student-cannot-see-drafts, admin-cannot-touch-results,
  non-owner-cannot-edit, published-requires-correction-flow.

## Workflow for Claude Code

- Read this file and docs/spec.md before large tasks.
- Work in small phases; do not scaffold unrequested modules.
- After schema changes: prisma migrate dev, then update seed script.
- Commit and push to GitHub after every completed feature or bug fix —
  do this automatically, without waiting to be asked. "Completed" means
  it typechecks, lints, and passes the test suite. Write a normal commit
  message describing the change; push to the current branch's remote
  (`origin`) right after committing.

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
Phase 4.2: Fixed the Results tab for GROUP-mode assessments — it was
  showing the flat individual grid regardless of mode. Now branches on
  assessment.mode: GROUP renders per-group cards (same-mark/different-marks
  toggle, confirm before overwriting existing varying marks, attendance
  still per-member under "same mark") plus a flagged "ungrouped" section
  for students in no group, replacing the old separate same-mark-only
  "Groups" tab entirely — DONE
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
  (superseded by Phase 3.7's batch/semester-number model; renamed to
  Transfer Students and repositioned as exceptions-only)
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
Phase 3.7: Batch/cohort class model + semester advancement — Class gains
  batchCode/section/studyMode/currentSemesterNumber (nullable, name
  auto-composed as "{batchCode}-{section}-{studyMode}" when all three are
  set); ClassCoursePlan gains semesterNumber (plan row is now class +
  level + course); Open Semester wizard rewritten as a 3-step
  Advance -> Assign -> Confirm flow that bumps currentSemesterNumber
  instead of moving students; Class Promotion renamed to Transfer
  Students and repositioned as an exceptions-only tool (repeaters,
  section changes) — DONE
Phase 3.8: One lecturer per course+class+semester — LecturerCourseAssignment
  uniqueness moved from (lecturer, course, class, semester) to just
  (course, class, semester); migration guards against pre-existing
  conflicting rows instead of silently dropping data; manual "Add
  Assignment" and the Open Semester wizard both pre-check and reject a
  second lecturer with a message naming the existing one — DONE
Phase 3.9: Bulk assign — Assignments page gains a "Bulk assign" dialog
  (lecturer-first or class-first entry, both flattening to the same row
  shape) for mid-semester/ad-hoc assignments, alongside the existing
  single Add Assignment form; the Open Semester wizard remains the main
  tool for opening a semester. One transaction per submit; rows that
  already exist, conflict with a different lecturer, or repeat within the
  batch are skipped with a per-row reason instead of failing the batch;
  auto-enrollment fires per created assignment; BULK_ASSIGNED audit log;
  result summary shown as "X created, Y skipped" with reasons — DONE
Phase 5: Student module — `/student` (own layout.tsx guard, redirect if not
  STUDENT; `/` also redirects a STUDENT session straight there). Dashboard
  (`page.tsx`): current class, active semester, and one row per active
  enrollment in that semester with a published-marks progress bar. Course
  page (`courses/[enrollmentId]/page.tsx`): every assessment for that
  course+class+semester (title/type/max marks always visible), MY mark
  shown only when published, with the Corrected badge + feedback text, plus
  the same semester-progress total. Fully read-only — no Server Actions,
  no schema changes; own-password-change was already covered by the
  existing `/change-password` route. All data access lives in
  `app/(app)/student/queries.ts`: every query is scoped through
  `student: { userId }` (or built from a `Student` row already looked up
  that way) — an enrollment id that doesn't belong to the session's own
  student simply returns null/not-found, which is what stops URL-guessing
  from reaching another student's data. Draft-invisibility is enforced by
  construction, not by hiding things in the UI: the assessments query's
  `results` relation is always filtered to `status: "PUBLISHED"`, so a
  draft mark is never fetched in the first place — a missing result and a
  still-draft result render identically ("—" / "Not published yet"),
  making drafts uninferable. `queries.test.ts` covers both the ownership
  scoping and the published-only filtering directly against the Prisma
  call shape — DONE
Phase 6: Dean module — `/dean` hub (own layout.tsx guard, redirect if not
  DEAN; `/` also redirects a DEAN session straight there), tabs Ownership
  Transfer | Close Semester | Reports. Ownership transfer reassigns an
  assignment's lecturer and creates one ownership_transfers row per
  existing assessment so the new lecturer can immediately keep
  editing/publishing/correcting (requireAssessmentOwner now resolves
  effective ownership through the latest transfer, created_by kept as
  history); blocked for closed semesters. Close semester locks the
  current active semester's assessments to CLOSED in one transaction,
  with a confirmation dialog warning about still-draft assessments losing
  the ability to ever publish; fixed a real gap where createAssessment
  had no closed-semester check at all. Reports (read-only, Excel export
  via `xlsx`) cover per-course (class performance + per-assessment
  breakdown), per-class (all-courses summary), and per-student (full
  cross-semester history) — published-results-only, matching the student
  portal's rule. New tests: `lib/auth.test.ts` (effective-owner
  resolution before/after transfer), `dean/transfers/actions.test.ts`,
  `dean/close-semester/actions.test.ts`, `dean/reports/queries.test.ts`
  — DONE

ALL PHASES DONE.

Post-completion additions:
- Staff password management on Admin -> Users: per-row Reset password
  (temp password shown once, same pattern as Student Accounts) and a
  UI-level self-action guard (can't reset/deactivate your own row) on top
  of the existing server-side CANNOT_DEACTIVATE_SELF/CANNOT_RESET_SELF
  checks. `users/actions.test.ts` added.
- Lecturer Reports (`/lecturer/reports`, its own nav entry, read-only) —
  one class-result matrix per assigned course: rows = actively enrolled
  students, columns = that course's assessments (title + Draft/Published
  badge), cell = the student's mark (or Absent/Exempt, with a "C" tag if
  corrected) — plus a Total/Possible and % column using the same
  earned/possible convention as the student portal and Dean reports
  (published-only; null/absent counts as 0 toward earned). A search box
  filters the visible rows by student_no/name; a "Group view" toggle (only
  shown when the course has StudentGroups) re-partitions the SAME matrix
  into per-group sections plus an "Ungrouped" section, instead of being a
  separate report. Export to Excel via the same `xlsx` pattern as Dean
  reports. All of it — the picker, the fetch action, and the export
  action — is scoped through `lecturerCourseAssignment.findFirst({where:
  {id, lecturer: {userId}}})` in `lecturer/reports/queries.ts`: another
  lecturer's assignment id just returns null/NOT_FOUND, never their data,
  which is also what `queries.test.ts` and `actions.test.ts` assert
  directly against the Prisma call shape.
- Dean sidebar un-hubbed + real dashboards for every role: `/dean` split
  from a single tabbed hub link into four standalone links (Dashboard,
  Ownership Transfer, Close Semester, Reports) — the `panel.tsx`/
  `actions.ts` per feature are untouched, only routing/`revalidatePath`
  changed; old `?tab=` URLs redirect. `nav-items.ts` gained the three new
  DEAN-scoped links and excluded DEAN from the generic "Dashboard" entry
  to avoid a duplicate-labeled row. All four roles now land on a real,
  read-only, data-backed dashboard instead of a placeholder — see the nav
  config bullet above for exactly what each role's dashboard shows.
- Semester gained an explicit `semesterNumber` (1 or 2) column — the
  Add/Edit Semester form is now a "Semester 1"/"Semester 2" dropdown
  instead of free text, with `(academicYearId, semesterNumber)` blocked
  from duplicating (see the "Add/Edit Semester" bullet above for the
  full mechanics and the migration's name-based backfill). Migration
  `20260709000000_semester_number`; `actions.test.ts` gained
  `createSemester`/`updateSemester` coverage (this admin sub-page had
  none before — only `openSemester` was tested).
- Fixed the manual Assignments page's course pickers (Add assignment +
  both Bulk assign directions) showing every course unfiltered, with
  duplicates. Now scoped to the selected class's `ClassCoursePlan` at its
  current level, class-before-course enforced via disabled state, and
  courses already assigned a lecturer for that class+semester excluded
  (see the "Course pickers" bullet above). Root cause of the duplicates:
  genuine duplicate `Course` rows in the data (same name, different ids),
  not a query join — the picker now dedupes defensively by name, but the
  underlying duplicate rows are still there and unmerged if a real
  data-cleanup pass is ever wanted.
- Pagination, filtering, and search added across the admin app using a
  new shared toolkit (see the "Table conventions" bullet above). Upgraded
  to server-side pagination: Assignments (Class/Course/Lecturer/Semester
  filters, search, semester defaults to active), Courses (status filter,
  search), Students (class filter, search), Enrollments (class/course/
  status filters, search), Users (role/status filters, search), and a
  brand-new Audit Logs page (`/admin/audit-logs`, entity filter, search,
  page size 25) that didn't exist before this pass — the Admin dashboard
  previously only showed a "last 8 entries" snippet. Lecturer Reports and
  Dean's per-course Reports tab got client-side pagination over their
  already-fetched result sets (no URL state — these are on-demand Server
  Action fetches, not page-load queries). Filter/page state lives in the
  URL everywhere it's server-paginated. No logic or permission changes —
  display only.

Update this section whenever a phase is completed.
