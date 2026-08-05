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

## Authorization model — RBAC + granular overrides (permission keys are the law)

The old fixed 4-role enum is GONE (Phase 7). Authorization is now:

- **Permission** rows (`permissions` table) mirror `lib/permissions.ts` —
  the single source of truth for keys (e.g. `assessment.publish`,
  `results.correct`, `semester.close`, `user.manage`), descriptions, and
  categories. Every Server Action maps to exactly ONE key. Adding a
  permission = add it to `lib/permissions.ts` + seed; never a raw insert.
- **Role** rows (`roles` table): ADMIN/DEAN/LECTURER/STUDENT are
  `isSystem` — never deletable or renamable, but their GRANTS are
  editable. Custom roles can be created/edited/deleted from the
  Roles & Permissions tab (`/admin/users?tab=roles`).
- **UserRole**: a user can hold MULTIPLE roles.
  **UserPermissionOverride**: per-user GRANT or DENY of one permission.
- **Effective permissions = union of all role grants − DENY overrides +
  GRANT overrides. DENY always wins over any role grant.** Computed by
  `getUserAccess()` in lib/auth.ts, cached in-memory (60s TTL,
  `lib/permission-cache.ts`) — every action that mutates roles/grants/
  overrides MUST call the matching invalidate helper.
- `requirePermission(key)` replaced `requireRole(...)` — no Server Action
  may check a role name. Ownership checks (`requireAssessmentOwner`,
  `requireAssignmentOwner`) and status checks (DRAFT/PUBLISHED/CLOSED)
  stay ON TOP of permissions — permissions replaced ROLE checks only.
- Role NAMES are presentation only: landing-page priority
  (ADMIN > DEAN > LECTURER > STUDENT in `app/(app)/page.tsx`), the
  top-bar badges, and the "which dashboard variant" branch. Never use a
  role name for authorization.
- Sidebar renders from effective permissions (`NavItem.permissions` =
  any-of list in nav-items.ts); section layouts gate on "any permission
  in this section"; each page/action still checks its own specific key —
  the server-side checks are the real boundary, the nav is cosmetic.
- Lockout guards (server-enforced, `lib/access-guards.ts`, checked
  INSIDE the transaction after applying changes so violations roll
  back): you cannot remove your own effective `user.manage`
  (SELF_LOCKOUT); no change may leave zero active users holding
  `user.manage` (LAST_USER_MANAGER — also blocks deactivating the last
  holder). STUDENT role membership is managed only via Student
  Accounts, never the access dialog (INVALID_ROLE).
- Every role/permission change is audit-logged with old->new:
  ROLE_CREATED/ROLE_UPDATED/ROLE_DELETED/USER_ACCESS_UPDATED.
- Permissions answer WHAT a user can do; for DEAN there is a second,
  orthogonal WHERE dimension: `dean_departments` (see the Dean module
  section) scopes a dean's `ownership.transfer`/`reports.view.all` to
  specific Departments ("faculties"). This is NOT a permission — no
  permission key changes based on it, `getUserAccess()`/`requirePermission`
  are untouched — it's a separate, always-fresh-queried lookup
  (`lib/dean-scope.ts`) applied inside dean-facing queries/actions on top
  of the permission check.

## NON-NEGOTIABLE SECURITY RULES

These are academic-integrity rules. Never relax them, even "temporarily".
Restated in permission terms — the seed grants in `lib/permissions.ts`
(DEFAULT_ROLE_GRANTS) encode them and `lib/permissions.test.ts` pins them:

1. **The ADMIN role holds ZERO assessment/results/groups permissions.**
   Admin can never create, edit, publish, or delete assessments, marks,
   or results — read-only on all academic data. Admin's grants are the
   management keys only (structure/calendar/curriculum/students/
   enrollments/user/roles/audit). Never grant an assessment or results
   key to ADMIN.
2. **Only the assessment's effective owner may edit it** — permission
   keys (`assessment.edit`, `results.enter`, …) are necessary but NOT
   sufficient; `requireAssessmentOwner` still applies on top. Other
   lecturers on the same course may not edit.
3. **Ownership transfer requires `ownership.transfer`** (seeded to DEAN
   only) — recorded in ownership_transfers with mandatory reason. Semester
   close requires `semester.close`, a global Academic Calendar action
   seeded to ADMIN only (see the "Semester lifecycle" bullet below).
4. **Students see ONLY published results** (`results.view.own` grants
   the student module; draft-invisibility is enforced in the query, not
   the UI). STUDENT's seed grant was originally exactly `results.view.own`
   and nothing else; deliberately extended (explicit user confirmation
   required and obtained — see the Faculty Daily Log roadmap entry) to
   also include `dailylog.view.own`, the same narrow read-only "entries
   that name me" grant LECTURER already holds — never `dailylog.view`
   (the full faculty log), never `dailylog.create`. Any FUTURE addition
   to STUDENT's grants needs the same explicit confirmation — this rule
   is about deliberateness, not about the grant list being literally
   frozen at one key forever.
5. **Published results are never edited directly.** Changes go through
   the correction flow (`results.correct` + owner + PUBLISHED status):
   ResultCorrection row (old_mark, new_mark, mandatory reason),
   is_corrected = true. Corrections are append-only.
6. **Every Server Action starts with `requirePermission(key)`** plus any
   ownership/status checks (lib/auth.ts). No exceptions. Prisma bypasses
   RLS, so the app layer is the ONLY security boundary.
7. **Audit log every critical action:** login (success + failure),
   assessment create/edit, marks entry/update, publish, correction,
   ownership transfer, enrollment transfer, user create/deactivate, and
   every role/permission change.
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
  row is BATCH + SECTION + STUDY MODE (e.g. batchCode "CMS26" + section
  "A" + studyMode "FT" -> display name "CMS26-A-FT"). A batch is
  permanent — students never move between class rows for normal
  progression. What advances each term is Class.currentSemesterNumber
  (1..8), bumped by the "Open semester" wizard. `name` is auto-composed
  from batchCode+section+studyMode whenever all three are set; legacy/
  edge-case classes may keep a manually-typed `name` instead (all four
  batch fields are nullable for exactly this reason — an admin can leave
  them blank and fill them in later without being blocked).
  `batchCode` itself is never free-typed — it's auto-derived at class
  creation from `program.code` + the last 2 digits of an admin-picked
  "intake year" (the batch's starting/cohort year, e.g. program "CMS" +
  intake 2026 -> "CMS26"), computed server-side in `composeClassData`
  (`admin/classes/actions.ts`) and shown read-only/live in the form
  (`admin/classes/classes-client.tsx`) as the admin fills it in — never
  trusted from client input. This is FIXED per cohort: it does NOT
  recompute from "today's" year on every view — `Class.intakeYear` (new
  nullable column, migration `20260721000000_class_intake_year`, no
  backfill so every pre-existing class keeps its original manually-typed
  batchCode untouched) stores the ORIGINAL intake year so an edit later
  re-shows and re-derives from that same stored value, not a value drawn
  from whatever year it happens to be when the admin opens the form. It
  only changes if an admin deliberately edits intake year/section/study
  mode on that class afterward. The "intake year" input defaults to the
  active AcademicYear's `startDate` year but is fully editable (for
  late-registered or backdated cohorts). Uniqueness of
  batchCode+section+studyMode is enforced via the composed `name`'s
  existing `@@unique([programId, name])` constraint, pre-checked before
  create/update with a friendly "A class named X already exists in this
  program" error — same pattern as every other duplicate guard in this
  app. No other place in the app enters a batchCode manually: Students
  bulk import's `class_code` column already matches against `Class.name`
  (an existing, already-created class), never a typed batchCode, and
  Courses/Lecturers bulk import don't reference classes at all — so
  nothing else needed to change for this.
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
- Close semester is a global ADMIN calendar action (`semester.close`,
  seeded to ADMIN, NOT Dean — moved off the Dean role; see the Dean module
  bullet below), not a separate page: it's an action on the active
  semester's row in Academic Calendar > Semesters
  (`admin/semesters/actions.ts`'s `closeSemester`, invoked from a "Close
  semester" item in that row's `...` menu in `semesters-client.tsx`).
  Targets ONLY the current active semester (there's only ever one).
  Confirmation dialog shows total assessment count and a specific warning
  for still-DRAFT ones — closing is one-way, so a draft closed here can
  never be published afterward and its marks never reach students.
  `closeSemester` sets Semester.is_closed = true and every DRAFT/PUBLISHED
  assessment in that semester to CLOSED, in one transaction
  (Semester.is_active is untouched — is_active/is_closed are orthogonal;
  the next Open Semester run is what eventually flips is_active). CLOSED
  immutability needs no per-action semester check anywhere: every write
  action already only allows exactly one prior status
  (saveResult/publishAssessment require DRAFT, correctResult requires
  PUBLISHED, applySameMarkToGroup requires DRAFT) — CLOSED matches none of
  them, so it's locked out automatically (this is also why the Open
  Semester wizard's "previous semester not closed" warning has always
  just read the single global `Semester.is_closed` boolean — nothing
  about that check needed to change with this move).`createAssessment`
  also checks `assignment.semester.isClosed` first, since assessment
  creation has no DRAFT/PUBLISHED/CLOSED status of its own to gate on.
  Audited as SEMESTER_CLOSED with the closed count and the still-draft
  count at close time, actor = the admin who closed it.
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
  `/dean/reports` = Reports; see the "Dean sidebar" bullet below for why
  this one diverges from the hub convention). Dean scope is deliberately
  narrow: ownership transfers, reports, and the dashboard — Close
  Semester is NOT a Dean tool (see the "Close semester is a global ADMIN
  calendar action" bullet above). Old `/dean?tab=transfers|close-semester
  |reports` links still work — `/dean/page.tsx` redirects them (the old
  close-semester tab now forwards to `/admin/calendar?tab=semesters`
  instead of a Dean route), so nothing bookmarked or shared before this
  change breaks.
  - **Faculty scoping (`dean_departments`)**: permissions
    (`ownership.transfer`, `reports.view.all`) define WHAT a dean can do;
    `dean_departments` defines WHERE — a dean's visible/actionable
    universe is exactly the classes whose Program belongs to one of their
    overseen Departments ("faculty" = `Department` in this schema; there
    is no separate `Faculty` entity), plus everything under those classes:
    students, enrollments, LecturerCourseAssignments, assessments,
    results, and the lecturers currently teaching them. A dean can oversee
    zero, one, or many departments (`DeanDepartment` join table,
    `user_id`+`department_id`, unique pair, university-wide dean = linked
    to every department). Zero departments (the default for every
    existing dean after the schema-only migration — no backfill) means
    the dean sees a friendly "No faculties assigned yet" empty state
    everywhere (dashboard, transfers, reports), never all data — this
    falls out of the scoping mechanism itself, not a special case: every
    helper's Prisma `{ in: [] }` clause matches zero rows by construction.
    Managed from Admin -> Users: any row currently holding the DEAN role
    gets a "Faculties overseen" `...`-menu item (checkbox list of
    Departments, `admin/users/dean-departments-dialog.tsx`) calling
    `updateDeanDepartments` (`admin/roles/actions.ts`, gated on
    `roles.manage` like its sibling `updateUserAccess` — replace-all
    transaction, audited as DEAN_FACULTIES_CHANGED with old/new
    department-name lists). All scoping logic is ONE helper module,
    `lib/dean-scope.ts`: `getDeanDepartmentIds(userId)` reads the join
    table, and a family of where-builders
    (`classDeanWhere`/`assignmentDeanWhere`/`enrollmentDeanWhere`/
    `assessmentDeanWhere`/`resultDeanWhere`/`studentDeanWhere`/
    `lecturerDeanWhere`/`dailyLogDeanWhere`) all compose from one base
    predicate (`{ program: { departmentId: { in: departmentIds } } }`,
    since Class has no department FK directly — only via
    `Class.programId -> Program.departmentId`) nested at the right
    relation depth for each entity (`dailyLogDeanWhere` is the one
    exception — `DailyLogEntry.departmentId` is direct, no Class/Program
    nesting needed, see the Faculty Daily Log bullet below). Every dean
    query/action applies the matching builder as part
    of the lookup itself (`findFirst({ where: { id, ...xDeanWhere(ids) }
    })`, never a plain `findUnique` + separate check) — same
    "ownership-check-IS-the-query" idiom as `requireAssignmentOwner` and
    the lecturer/student portals, so an id from another faculty simply
    doesn't come back (NOT_FOUND), not a 403 that would leak its
    existence. No caching layer for department scope (unlike
    `getUserAccess`'s 60s permission cache) — it's queried fresh per
    request, same as every other dean/report query in this codebase; see
    the reasoning in `lib/dean-scope.ts`'s design notes if this ever
    needs revisiting under load. `lecturerDeanWhere` (lecturers with at
    least one in-scope assignment) is also the candidate pool for
    ownership transfer's "new lecturer" picker — a dean can only
    reassign to a lecturer already visible to them, not any lecturer
    university-wide. A user can hold DEAN and LECTURER at once (multi-
    role is normal); the two scoping systems are fully independent —
    dean_departments never touches lecturer-side ownership queries
    (`lecturer: { userId }`, unchanged) and vice versa.
  - **Ownership transfer** (`dean/transfers/`): Dean picks an existing
    LecturerCourseAssignment (course+class+semester, scoped to their
    departments — both the list shown and the server-side lookup in
    `transferOwnership`) and a new lecturer (scoped to
    `lecturerDeanWhere`), with a mandatory reason. `transferOwnership`
    updates LecturerCourseAssignment.lecturerId to the new lecturer AND
    creates one ownership_transfers row (from/to/transferredBy/reason)
    per existing, non-deleted assessment under that assignment — in one
    transaction. Assessment.created_by is NEVER changed (kept as
    permanent history of who first made it); "who can currently edit" is
    instead resolved by `requireAssessmentOwner` (lib/auth.ts) as the
    most recent ownership_transfers row's `toLecturer` for that
    assessment, falling back to created_by when there's no transfer. This
    is what makes "Draft/published rules keep working for the new owner"
    true — DRAFT assessments become editable/publishable and PUBLISHED
    ones become correctable by the new lecturer immediately, with zero
    special-casing in saveResult/publishAssessment/correctResult/
    updateAssessment (they all already just call requireAssessmentOwner).
    The old lecturer loses access for free too: every "My
    Courses"/assignment-detail query is scoped through `lecturer: {
    userId }` on the assignment's CURRENT lecturerId, which the transfer
    already flipped. Blocked for an assignment in a closed semester
    (CLOSED_SEMESTER), a no-op transfer to the same lecturer
    (SAME_LECTURER), an out-of-scope assignment (NOT_FOUND), or an
    out-of-scope new lecturer (LECTURER_NOT_FOUND). Audited as
    OWNERSHIP_TRANSFERRED on the assignment, with the reason and affected
    assessment count.
  - **Reports** (`dean/reports/`, read-only, Excel export via the `xlsx`
    package already used for bulk-import templates): per-course (one
    LecturerCourseAssignment — class performance avg/top/lowest plus a
    per-assessment avg/top/lowest breakdown), per-class (one class+
    semester — every course's average side by side, reusing the per-course
    calculation), per-student (full cross-semester enrollment history).
    All three are faculty-scoped (the assignment/class/student lookup
    itself is the scope check, `queries.ts` takes `departmentIds` as a
    parameter resolved once per action call in `actions.ts`) AND
    PUBLISHED-results-only, same rule as the student portal — a Dean
    report is not a backdoor into draft marks. Per-student history is
    additionally scoped per-ENROLLMENT, not just via the student's
    current class: a past enrollment under an out-of-scope class (e.g.
    before a transfer in from another faculty) stays invisible even
    though the student themselves now resolves in-scope. A still-draft
    assessment still appears in the per-course breakdown (so the Dean can
    see grading isn't done) but contributes nothing to any average/top/
    lowest figure. A null (absent/exempt) published mark counts as 0
    toward earned, consistent with the student portal's semester-progress
    math. Report data crosses the Server Action boundary via `select`
    (not `include`) on the lecturer relation — no password hashes riding
    along in the payload just to show a name.
  - Dean dashboard's assessment counts (`dean/queries.ts`'s
    `getDeanAssessmentCounts`) are scoped the same way — an unassigned
    dean gets the zeroed shape without a DB round-trip at all.
  - Dean is read-only on results everywhere else — no entry/edit/publish
    or close-semester action exists under `/dean`, only ownership
    transfer, the reports, and the Daily Log (below).
- Faculty Daily Log — notes/leave notices/problems logged against a
  faculty (Department), written by ADMIN or DEAN, full log visible to
  ADMIN and DEAN only (still no STUDENT access at all; LECTURER gets a
  narrow read-only exception — see below). Lives at BOTH
  `/admin/daily-log` and `/dean/daily-log` — genuinely one feature with
  two entry points, not two separate implementations: both routes render
  the exact same `admin/daily-log/panel.tsx`'s `DailyLogPanel` (imported
  directly into `dean/daily-log/page.tsx`, no separate Dean panel file
  exists). Two permission keys, `dailylog.create`/`dailylog.view`,
  seeded to BOTH ADMIN and DEAN (migration `20260722010000_
  dailylog_permissions`, same idempotent role_permissions-grant pattern
  as `close_semester_to_admin`) — deliberately shared, since permissions
  answer WHAT, not WHERE. Because the same two keys are held by both
  roles, the route/nav-item split is cosmetic ONLY, same as everywhere
  else in this app — the REAL scoping boundary is re-derived from the
  caller's actual ROLE inside the shared logic itself, every single
  call, regardless of which URL got them there:
  - **Read** (`admin/daily-log/queries.ts`'s `getDailyLogPanelData`):
    checks `getUserAccess(userId).roleNames` for `"DEAN"`. A pure ADMIN
    gets every faculty, unscoped. A DEAN (including a DEAN+ADMIN
    multi-role user — role check, not permission check) always gets
    exactly their own `dean_departments` scope for entries/faculties,
    via a new `dailyLogDeanWhere` in `lib/dean-scope.ts` (reusing the
    same helper module and "ownership-check-IS-the-query" idiom as
    Ownership Transfer/Reports — never a new/duplicate scoping
    mechanism). An unassigned DEAN gets the same "No faculties assigned
    yet" empty-state shape as every other dean-scoped feature. The
    lecturer list is the one deliberate exception — see below.
  - **Write** (`admin/daily-log/actions.ts`'s `createDailyLogEntry`):
    same role branch — ADMIN may set `departmentId` to any faculty; DEAN
    must submit a `departmentId` inside their own `dean_departments`
    (FORBIDDEN_DEPARTMENT otherwise, including for an unassigned DEAN,
    whose empty scope array rejects every department by construction).
  - `DailyLogEntry.type` is `LEAVE_NOTICE | PROBLEM | NOTE`. "Who this is
    about" — `relatedLecturerId` or `relatedStudentId` (both nullable,
    never both set on the same row, enforced by a Zod `.refine` and
    re-checked server-side) — is the SAME optional lecturer-or-student
    choice for ALL THREE types, via one shared "About a lecturer" /
    "About a student" toggle component, `RelatedPersonField`
    (`admin/daily-log/daily-log-client.tsx`) — not duplicated per type.
    LEAVE_NOTICE requires exactly one (`allowNone={false}`, no "Neither"
    button — a leave notice without a subject doesn't make sense);
    PROBLEM/NOTE make it fully optional (`allowNone={true}`, defaulting
    to "Neither"). Quick-add friction on a LEAVE_NOTICE is cut by never
    asking for a typed title: the server derives `title` from whichever
    of lecturer/student was picked (`"Leave notice — {fullName}"`) — this
    used to only handle the lecturer case; fixed to handle either,
    uniformly, in `createDailyLogEntry`. The lecturer lookup is
    deliberately UNSCOPED by faculty for every type (not
    `lecturerDeanWhere`) — there is no Lecturer->Department relation in
    the schema, only a transitive one through current course assignments,
    and scoping by "currently teaching in-scope" made the picker empty
    for any faculty with no active assignments yet (found during manual
    testing). The student lookup IS dean-scoped (`studentDeanWhere`, both
    in `createDailyLogEntry`'s validation and the picker's options in
    `getDailyLogPanelData`) for every type — a student always has a real
    home department via `class -> program`, so there's no "quiet faculty"
    empty-picker problem the way there was for lecturers; reusing the
    existing helper is simply correct here, not a compromise. The
    entry's own `departmentId` stays fully dean-scoped either way; who
    gets named inside it is the narrower, per-field question above. A
    "Quick leave notice" button opens the identical dialog pre-set to
    `type = LEAVE_NOTICE` and the toggle defaulted to "About a lecturer"
    (the common case; still fully switchable to student), rather than
    being a second form to maintain. Display: the list table's "Related"
    column shows whichever of `relatedLecturer`/`relatedStudent` is set
    — same rendering for all three types, unconditional on `type` —
    falling back to "—" like every other empty cell in that table; no
    separate always-visible "Student" column, which would just be empty
    clutter for the common case.
  - **Student-facing visibility deliberately NOT extended**: no STUDENT
    role permission for Daily Log exists at all (STUDENT holds
    `results.view.own` only) — this was verified directly against the
    schema/permission catalog before any of the `relatedStudentId` work
    above, since the request that added it repeated a false premise
    (that a student-facing `dailylog.view.own` already existed and was
    scoped by `relatedStudentId`). It doesn't. A student named in a
    NOTE/PROBLEM entry today has exactly the same (zero) visibility into
    Daily Log as before this feature — only ADMIN/DEAN (full log) and
    LECTURER (`dailylog.view.own`, LEAVE_NOTICE-only, see above) can see
    any entry. If student-facing visibility is wanted later, it needs an
    explicit new decision (a `dailylog.view.own` grant to STUDENT plus a
    student-facing query scoped through `relatedStudent: { userId }`) —
    deliberately not added here per the "ask before exposing PROBLEM/NOTE
    to students" instruction that came with this request.
  - The faculty picker (Select/`SearchableSelect`, both in the filter bar
    and the create dialog) is shown only when there's more than one
    department to choose from — for ADMIN that's effectively always;
    for a DEAN it's hidden (auto-set to their one faculty) unless they
    oversee more than one, matching every other "faculty picker" rule in
    this app.
  - List view reuses the standard pagination/filter toolkit (`lib/
    pagination.ts` + `lib/use-url-table-state.ts` +
    `TablePagination`/`TableSearchInput`, same as Audit Logs) — filters:
    free-text search (title/description), type, faculty (when shown),
    and a single-day date filter (`entryDate` between that day's start
    and end, UTC). Every filter ANDs on top of the role-derived scope,
    so a filter value outside a Dean's own scope just yields zero rows,
    never a leak.
  - Audited as DAILYLOG_CREATED (department/type/title/lecturer in
    `newValue`, no diff — matches the plain "created X" audit convention
    used elsewhere, e.g. `ENROLLMENT_CREATED`). No edit/delete action
    exists — entries are append-only, consistent with this app's
    soft-delete/audit-log philosophy elsewhere (nothing in the spec
    asked for correction/removal, so none was added).
  - **LECTURER and STUDENT read-only exception**: a third permission key,
    `dailylog.view.own` (same "view.own" shape as
    `results.view.own`/`reports.view.own`/`assessment.view.own`), seeded
    to LECTURER (migration `20260723000000_dailylog_view_own`) AND
    STUDENT (migration `20260727000000_dailylog_view_own_student`) — NOT
    `dailylog.view` (the full-faculty-log permission stays ADMIN/DEAN-
    exclusive) and NOT `dailylog.create` for either. Neither role ever
    sees the faculty log itself, only LEAVE_NOTICE entries that name THEM
    specifically: `getMyLeaveNotices` (`admin/daily-log/queries.ts`)
    filters through `type: "LEAVE_NOTICE", relatedLecturer: { userId }`
    for a lecturer; `getMyLeaveNoticesForStudent` filters through
    `type: "LEAVE_NOTICE", relatedStudent: { userId }` for a student —
    same query-IS-the-ownership-check idiom, same file, mirrored exactly.
    A LEAVE_NOTICE about a student has `relatedLecturer: null` (and vice
    versa), so each widget only ever shows entries actually about that
    specific person — "leave notices about me", not "leave notices I
    might care about". Surfaced as a "My Leave Notices" read-only widget
    (5 most recent) on the Lecturer dashboard (`app/(app)/page.tsx`'s
    `LecturerOverview`) and, separately, on the Student dashboard
    (`app/(app)/student/page.tsx`) — both gated on
    `ctx.permissions.has("dailylog.view.own")` so a custom role without
    it never even queries for the widget; `student/layout.tsx`'s section
    gate was extended from a single `results.view.own` check to an
    any-of-`[results.view.own, dailylog.view.own]` array, matching the
    multi-permission pattern every other section layout already uses.
    Neither role can write — `dailylog.create` was never granted to
    either, only ADMIN/DEAN; `dailylog.view.own` is read-only by
    construction (no corresponding action exists for it). The STUDENT
    grant is a deliberate, explicitly-confirmed exception to this app's
    "STUDENT holds only results.view.own" rule — see NON-NEGOTIABLE
    SECURITY RULE 4 above, updated to describe this as intentional rather
    than removing the rule.
- Class Timetable — scheduling of course + lecturer + day + time + room per
  class/semester, with server-side conflict detection. `Room(id, name,
  capacity nullable, deletedAt)` is a shared, faculty-independent physical
  resource (no Department relation in the schema); `TimetableSlot(id,
  lecturerCourseAssignmentId, dayOfWeek [MON..SAT], startTime, endTime,
  roomId)` hangs off an existing `LecturerCourseAssignment`, so course +
  class + semester + lecturer are already resolved through it rather than
  duplicated onto the slot. `startTime`/`endTime` are zero-padded "HH:MM"
  24h strings, not a DB `TIME` column — sidesteps timezone-of-a-time-with-
  no-date ambiguity entirely and still compares correctly both
  lexicographically and via the minutes-since-midnight conversion conflict
  detection uses. Three permission keys, same WHAT/WHERE split as every
  other dean-scoped feature: `timetable.manage`/`timetable.view` seeded to
  ADMIN (any class) and DEAN (their own faculty only, via
  `assignmentDeanWhere`/`classDeanWhere` reused from `lib/dean-scope.ts` —
  never duplicated), and a narrower `timetable.view.own` seeded to
  LECTURER and STUDENT for their own read-only schedule (same "view.own"
  shape as `dailylog.view.own`/`results.view.own`).
  - **Room is a class-registration property, not a scheduling-time
    choice.** `Class.roomId` (nullable FK to `Room`) is the class's single
    default room, set from the Class create/edit form under Academic
    Structure > Classes (optional there — a class can exist before its
    room is finalized) — never asked for at build/generate time anymore.
    Both the drag-and-drop Build Timetable
    (`admin/timetable/build-timetable-client.tsx`) and the auto-timetable
    generator (`admin/auto-timetable/`) read `Class.roomId` directly and
    use it for every session of that class; a class with no room set
    blocks building/generating FOR THAT CLASS SPECIFICALLY (other classes
    in the same session/batch are unaffected) with a message naming the
    class and a direct link to its edit form
    (`/admin/structure?tab=classes&editClassId=<id>`, which
    `classes-client.tsx` reads to auto-open that class's edit dialog) —
    never silently guessed, never blocking the whole page/batch. The
    pre-existing per-session room OVERRIDE (Build Timetable's "different
    room for this session" toggle on a placed card) is unchanged — it's
    still how a genuine one-off exception (e.g. a lab) gets a different
    room than the class's default; it just no longer doubles as how the
    class's PRIMARY room gets set. See the "Room assignment moves to
    class registration" roadmap entry for the full migration/backfill
    mechanics.
  - **Conflict detection** (`lib/timetable-conflicts.ts`) is a pure,
    DB-free function — `findTimetableConflicts(input, candidates,
    excludeSlotId?)` — reused identically by the real pre-check inside
    `createTimetableSlot`/`updateTimetableSlot` (blocking, throws a
    message naming every conflict found — never just the first one, same
    "collect everything, don't fail on the first hit" convention as
    bulk-assign/open-semester) and by a separate `checkTimetableConflicts`
    preview action the Add/Edit dialog calls live (debounced) for the
    inline warning before submit. The preview is advisory only — the real
    action re-validates server-side regardless, same trust boundary as
    everywhere else in this app. Three independent rules, all requiring a
    genuine day+time overlap (`timeRangesOverlap`, any range intersection;
    a slot ending exactly when another starts does NOT overlap) AND
    matching same semester (candidates are always fetched scoped to the
    target assignment's own `semesterId` — reusing a Monday-9am slot
    across different semesters is normal, not a conflict): same room +
    different assignment; same lecturer (via the assignment) + different
    class; same class (via the assignment) + overlapping time regardless
    of lecturer. Conflict-free-ness is NOT a DB constraint (overlap can't
    be expressed as a simple unique index) — enforced in application code
    before every create/update, per this app's established
    query-for-what-exists-before-writing convention. Room conflicts are
    checked across EVERY caller's slots, not just the caller's own faculty
    — a Dean must be blocked from double-booking a room another faculty
    already holds, not just their own, so `getConflictCandidates` is
    deliberately unscoped by dean_departments even though the rest of the
    feature is scoped by it.
  - **Who manages**: `/admin/timetable` and `/dean/timetable` render the
    exact same shared panel (`admin/timetable/panel.tsx`, imported
    directly by `dean/timetable/page.tsx` — no separate Dean panel file),
    same "one implementation, two routes" pattern as Faculty Daily Log.
    Because `timetable.manage`/`timetable.view` are held by both roles,
    the route alone can't be the scoping boundary — `getTimetablePanelData`
    and every mutating action in `admin/timetable/actions.ts`
    (`resolveScopedAssignment`/`resolveScopedSlot`) re-derive the real
    boundary from the caller's actual ROLE every call
    (`getUserAccess(userId).roleNames.includes("DEAN")`), same idiom as
    Daily Log. An unassigned DEAN gets the same "No faculties assigned
    yet"-shaped empty state as every other dean-scoped feature. Editing an
    existing slot re-checks scope on BOTH the slot being edited AND the
    newly-chosen assignment — a Dean can't retarget an in-scope assignment
    onto an out-of-scope existing slot id, or vice versa.
  - **Campus** — a top-level entity Rooms belong to (`Campus(id, name
    unique, address nullable, deletedAt)`, migration `20260727030000_
    campus`). Same shared/unscoped/`timetable.manage`-gated resource as
    Room, same deactivate/reactivate soft-delete convention as every other
    simple-CRUD entity in this app (Department/Program/Room) — no separate
    `isActive` boolean was introduced, to keep Campus consistent with
    Room's own active/inactive pattern rather than a one-off shape.
    `Room.campusId` is a REQUIRED FK (not nullable) — the existing DB had
    4 pre-existing Room rows with no campus concept at all when this
    landed; rather than guess, the app owner was asked directly whether to
    auto-create a default "Main Campus" and backfill them, or require
    manual assignment first. Confirmed: auto-create + backfill. The
    migration creates "Main Campus" (only if at least one Room already
    exists — a fresh DB with zero rooms gets no phantom default campus),
    assigns every existing Room to it, then tightens `campus_id` straight
    to `NOT NULL` in that same migration. **Room.name's uniqueness moved
    from global to per-campus** (`@@unique([campusId, name])`, was a plain
    `name @unique`) — this is a deliberate, necessary consequence of the
    feature's own stated reasoning, not incidental: the whole point of
    showing "Room name — Campus" in every picker is that a large
    university may have identically-named rooms at different campuses, so
    the old global-uniqueness constraint would have made that scenario
    impossible to create in the first place.
  - **UI**: `components/timetable/weekly-grid.tsx` (a time-row/day-column
    grid, MON-SAT-ish columns sorted by day then start time rather than
    pixel-positioning a real calendar) is now used ONLY by Lecturer/
    Student's own read-only pages — Admin/Dean no longer render it at all.
    Admin/Dean's own editable view is a single unified list (session
    cards, not a grid), covered in full by the "Timetable is ONE unified
    view, not tabs" roadmap entry below — that entry is the authoritative
    description of the current Admin/Dean UI (Now/shift/day/Class/
    Lecturer/Room/Campus/Semester filters, the Add/Edit dialog, Export
    Excel); this bullet is intentionally not duplicating it. The Add/Edit
    dialog itself (assignment/day/room pickers + start/end time inputs +
    the inline conflict warning) is unchanged by that move — the Room
    picker's items are labelled `"{room.name} — {room.campus.name}"` with
    the campus name also added as a search keyword; picking a course
    assignment prefills the Room field with whichever room already
    accounts for most of that class's OTHER existing sessions — matching
    the "one room per class" norm — but only while the field is still
    empty, so it never overwrites a room already chosen, still fully
    editable regardless, see the "Business rule change — One room per
    class" roadmap entry for the full reasoning. Room/Campus CRUD itself
    (including the "Bulk add rooms" dialog) does NOT live on this page —
    see the "Business rule change — Campus & Room management moved to its
    own section" roadmap entry: this page only READS `Room`/`Campus` as
    reference data.
    Lecturer and Student each get
    their own dedicated read-only page (`/lecturer/timetable`,
    `/student/timetable` — a full weekly grid doesn't fit as a dashboard
    widget the way "My Leave Notices" does, so unlike Daily Log's
    lecturer/student extension this one is a standalone nav entry, not a
    dashboard card) rendering the same `WeeklyGrid` with no edit/delete
    handlers passed in, which is what hides the per-slot menu entirely.
  - **Read-only own views**: `getMyTimetableForLecturer` scopes through
    `assignment: { lecturer: { userId } }`, the query-IS-the-ownership-
    check idiom used everywhere. `getMyTimetableForStudent` is one step
    more involved — there is no direct relation from
    `StudentCourseEnrollment` to `LecturerCourseAssignment` (enrollments
    key on course+class+semester; assignments are the
    lecturer+course+class+semester tuple, matched only implicitly) — so it
    first resolves the student's own ACTIVE enrollments (itself scoped via
    `student: { userId }`) into course/class/semester tuples, then matches
    `TimetableSlot`s whose assignment exactly equals one of those tuples.
    A student with no active enrollments gets an empty schedule without
    ever querying slots, never another student's.
  - Audited as `TIMETABLE_SLOT_CREATED`/`_UPDATED`/`_DELETED` via the
    standard `lib/audit.ts` helper, old/new values on update, old value
    only on delete — same shape as every other CRUD audit entry in this
    app.
  - **FT/PT valid teaching days**: a class's valid teaching days depend on
    its `studyMode` — FT is Saturday through Wednesday, PT is Thursday and
    Friday only (`VALID_DAYS_BY_STUDY_MODE` in `lib/timetable-days.ts`;
    times themselves are free-form within those days, no fixed shift
    hours). `DayOfWeek` gained `SUN` (migration
    `20260727040000_dayofweek_sunday`) specifically for this — the
    original 6-value enum had no Sunday at all. A class with no
    `studyMode` set yet (nullable, legacy/incomplete batch data) has NO
    day restriction — every day is allowed, matching this app's
    established fallback for other nullable batch fields. Enforced
    server-side on every path that creates/edits a slot
    (`createTimetableSlot`/`updateTimetableSlot`/`buildClassTimetable` all
    call the same `isValidDayForStudyMode` check) with a clear rejection
    message naming the day; the Add/Edit Slot dialog's Day dropdown also
    only OFFERS the valid days for whichever assignment is selected
    (narrows live as the assignment changes, clearing an now-invalid
    picked day rather than leaving a stale one), so an admin/dean can't
    even select an invalid day in the first place, not just get blocked
    on submit.
  - **Campus/Room permissions split from timetable.manage**: two new ADMIN
    -only keys, `campus.manage` and `room.manage` (migration
    `20260727050000_campus_room_permissions`), replacing the
    `timetable.manage` check that used to gate Campus/Room CRUD. DEAN
    keeps `timetable.manage`/`timetable.view` (scheduling classes into
    rooms, scoped to their faculty) but does NOT get the two new keys —
    the physical campus/room inventory is centrally administered, not a
    per-faculty concern, same "ADMIN manages structure, DEAN operates
    within it" split as `structure.manage`. Originally this just hid the
    Add/Bulk-add/Edit/Deactivate controls on Rooms/Campuses tabs that
    still lived inside the Timetable page (`TimetablePanel` computing
    `canManageCampuses`/`canManageRooms`); since the "Campus & Room
    management moved to its own section" change below, that whole
    section is ADMIN-only end to end (a DEAN with only `timetable.manage`
    can no longer reach `/admin/campuses` at all — see the Admin nav
    bullet's `AdminLayout` gate) rather than being reachable-but-read-only
    from Timetable.
  - **Shifts — optional time-entry templates, never a hard constraint**:
    `Shift(id, name, studyMode [FT|PT], startTime, endTime, deletedAt)`
    (migration `20260727060000_shifts`) is a reusable time-of-day preset
    (e.g. "Shift 1 (FT): 08:00-12:00") scoped to a studyMode — a study
    mode can have several. Gated by a third ADMIN-only key,
    `shift.manage` (migration `20260727070000_shift_permission`, same
    "centrally administered, not per-faculty" reasoning as campus.manage/
    room.manage, same `canManageShifts`-hides-the-controls UI treatment
    via a new "Shifts" tab, `admin/timetable/shifts/`). Critically,
    `TimetableSlot` has NO relation to `Shift` at all — a shift pick is
    purely a client-side convenience that copies its `startTime`/
    `endTime` into the (always-editable, never-locked) time fields
    already on the form; the slot itself only ever stores the resulting
    plain strings, exactly like a hand-typed time. This is why reading/
    picking a shift needs no permission beyond `timetable.manage` itself
    (unlike creating one) — a `getShiftOptions` list in
    `admin/timetable/queries.ts`, unscoped like campuses/rooms. Offered
    in both places a session's time is entered: the single-slot Add/Edit
    dialog (filtered to the SELECTED ASSIGNMENT's class's studyMode,
    recomputed live as the assignment changes, same pattern as the Day
    picker) and the Build Timetable week builder (filtered to the ONE
    selected class's studyMode, shared by every row since every session
    in that builder already belongs to the same class). Because picking
    a shift only ever calls `setValue`/`updateSession` on the plain
    startTime/endTime fields, conflict detection (`findTimetableConflicts`
    /`findWeekBuilderConflicts`) needed zero changes — it already only
    ever looks at the resulting time, never caring where it came from.
  - **"Build timetable" — the whole-week builder**
    (`admin/timetable/build-timetable-client.tsx`, the default-selected
    tab on the Timetable page): builds an ENTIRE class's week in one
    submit instead of one slot at a time. Pick a class (dean-scoped,
    reusing the panel's existing scoped `classes` list — no new scoping
    logic needed) and a semester; the class's `studyMode` determines which
    day-columns are even OFFERED (FT: Sat-Wed, PT: Thu-Fri) — an
    unavailable day never appears as a section to add sessions under, not
    just rejected on submit. **Room is picked ONCE per class, at the top
    of the form** (business rule: a class normally uses the SAME room for
    its entire week, not a different one per session) — every session
    added below automatically uses that one room, computed at submit time
    as `row.roomOverride ? row.roomId : mainRoomId` per session, so
    changing the top picker re-applies to every non-overridden row with no
    extra sync needed. Each day section has its own free-form list of
    sessions (course-assignment picker restricted to that class's actual
    assignments for the selected semester, start/end time, and a
    secondary, off-by-default "Different room for this session" checkbox
    for the genuine exception case — e.g. one course needing a lab —
    which reveals a normal `"Room — Campus"` picker seeded with the
    class's main room but freely changeable; unchecking it drops the row
    back to silently following the main room), add/remove per row, no
    fixed count, any day can stay empty. `buildClassTimetable`
    (`admin/timetable/actions.ts`) is deliberately NOT shaped like the
    single-slot actions — it returns a structured `{ok: true, created} |
    {ok: false, violations: {sessionKey, message}[]}` result instead of
    throwing one joined error string, because a whole-week submission can
    have many independent problems across many rows and the UI needs to
    show each one against the specific row that caused it. Validates, in
    order, per session: day-valid-for-studyMode, the assignment actually
    belongs to the selected class+semester (defends against a tampered
    assignmentId), then a full conflict check via
    `findWeekBuilderConflicts` (`lib/timetable-conflicts.ts`) — the new
    piece here versus the single-slot path is that every session is
    checked BOTH against existing DB slots for that semester (via the
    already-existing `getConflictCandidates`) AND against every OTHER
    session in the same submitted batch, since two sessions in one
    submission can conflict with each other before either exists in the
    DB. All-or-nothing: if ANY violation exists anywhere, NOTHING is
    created — the UI keeps every row's entered data in place (nothing is
    ever cleared on failure, only on a genuine success) and shows each
    row's own violation messages inline beneath it, so an admin can fix
    just the flagged rows and resubmit without re-entering the whole
    week. On success, all sessions are created via one `createMany` call
    and audited as a single `TIMETABLE_WEEK_BUILT` entry (classId,
    semesterId, sessionCount) — not one audit row per session, matching
    the existing BULK_ASSIGNED/BULK_IMPORT "one summary entry per batch
    operation" convention. Single-session add/edit/delete for later
    mid-semester adjustments continues to use the pre-existing Weekly
    Grid tab's Add/Edit dialog and delete action unchanged — the week
    builder is for building a week from scratch, not the only way to
    touch a slot afterward.
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
- Lecturer registration is likewise separate from account creation,
  mirroring Student exactly (see the "Lecturer registration split"
  roadmap entry for the full mechanics): registering a lecturer (staff_no,
  full_name, phone_number, title, department) at Admin -> Lecturers
  creates only a Lecturer row — `Lecturer.userId` is nullable, so a
  lecturer can be assigned to teach a course (LecturerCourseAssignment
  requires no account) before ever getting a login. Accounts are
  generated later, per lecturer or by department, from the standalone
  Lecturer Accounts page: **username = phone_number, not email** —
  `Lecturer.phoneNumber` is required and unique for exactly this reason
  (same role `Student.studentNo` plays), `User.email` is left `null` for
  these accounts (nullable at the DB level now). `Lecturer.fullName` is
  its own canonical field (independent of any User, same reasoning as
  Student.fullName) since `Lecturer.userId` being nullable means
  `lecturer.user.fullName` can no longer be relied on anywhere in the
  app — every lecturer-name display reads `lecturer.fullName` directly.
- User.username is unique and always set: ADMIN/DEAN/custom-role staff
  and legacy lecturer accounts use their email; students use their
  student_no; lecturer accounts generated via Lecturer Accounts use their
  phone_number. Login accepts EITHER username or email (case-insensitive),
  resolved with a single OR query — this already worked unmodified for
  phone-based lecturer login, since phone numbers never collide with the
  email pattern.
- Admin -> Users manages ADMIN/DEAN/custom-role staff accounts —
  email-based, created via the "Add user" dialog. It does **not** create
  or edit LECTURER accounts/profiles at all anymore (`createUser` rejects
  role LECTURER outright; `updateUser` rejects editing an existing
  LECTURER row, since overwriting a phone-based account's required-email
  form field would silently corrupt its username/login) — lecturer
  accounts are created exclusively via Lecturer Registration + Lecturer
  Accounts. Existing (pre-this-feature) LECTURER rows still list here for
  their non-profile account lifecycle — Roles & permissions, "Faculties
  overseen" is DEAN-only anyway, Reset password, Deactivate/Reactivate —
  none of which touch email/username, so they stay safe regardless of
  login method. STUDENT accounts are managed exclusively through Student
  Registration + Student Accounts. Each row's ... menu has Edit (disabled
  for LECTURER rows), "Roles & permissions" (RBAC — see the Authorization
  model section), "Faculties overseen" (DEAN rows only — dean_departments
  scoping, see the Dean module section), Reset password, and
  Deactivate/Reactivate. Reset password (`resetUserPassword`) generates a
  fresh temp
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
- Bulk import (admin-only) exists for Students, Courses, Lecturers, and
  staff Users via one reusable flow: `components/admin/bulk-import-dialog.tsx`
  (generic Upload -> Preview -> Confirm dialog) driven by shared helpers in
  `lib/import/` (`parse.ts` for SheetJS parsing + 5MB/2000-row limits,
  `template.ts` for xlsx template generation, `preview.ts` for the
  duplicate-in-file/already-exists/OK row classification, `types.ts` for
  the shared shapes) plus a `bulk-import-actions.ts` per entity
  (students/courses/lecturers dirs) that supplies the template/preview/confirm
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
  creates, uppercasing codes like the manual form; Lecturers import (now
  at `admin/lecturers/bulk-import-actions.ts`, moved off Users — see the
  "Lecturer registration split" roadmap entry) creates ONLY Lecturer rows
  (staff_no, full_name, phone_number, department), no User/account,
  mirroring Students import exactly — accounts are generated afterward
  from Lecturer Accounts, never by this import. Its dedup logic checks
  TWO independent unique keys (staff_no AND phone_number, either of which
  can collide alone) instead of the generic single-key `lib/import/preview.ts`
  helper every other import uses. Every import is audit-logged as
  `BULK_IMPORT` with entity type, filename, and row counts. Re-uploading
  an already-imported file is naturally idempotent — the second preview
  marks every row ALREADY_EXISTS, so confirm has zero OK rows to act on.

## WhatsApp Notifications (optional, unofficial, best-effort)

**This is NOT the official Meta Business API.** It automates a real
WhatsApp number via an unofficial library (Baileys, using the WhatsApp
Web protocol) run as a separate, self-hosted Node.js process
(`whatsapp-service/`) on a VPS — never inside the Next.js app's
request/response cycle. This violates WhatsApp's ToS and risks the
number being banned at any time; that risk is accepted knowingly. **The
main app must be fully functional with this feature entirely off** — no
core flow (auth, marks, results, timetable, anything) may ever depend on
a WhatsApp send succeeding, or on the worker process even being alive.

- **Zero direct coupling between the two processes.** The Next.js app
  (Vercel, serverless) and the WhatsApp worker (VPS, long-running) never
  call each other over the network — they coordinate ENTIRELY through
  two shared Postgres tables. This is deliberate: a serverless function
  calling out to a VPS endpoint would need public exposure + auth and
  could hang/time out; a DB-mediated queue needs neither, and the DB
  connection is already a hard dependency both sides have anyway.
  - `whatsapp_notification_logs` is both the outbox QUEUE and the
    delivery LOG — one row per notification attempt (`PENDING` ->
    `SENT`/`FAILED`), with `recipientType`/`recipientId` (Student.id or
    Lecturer.id, no FK — polymorphic, mirrors AuditLog's entity/entityId
    shape) plus a `recipientName`/`phoneNumber` snapshot so the log stays
    readable even if the profile is later changed/deleted.
  - `whatsapp_settings` is a single row (`id = "singleton"`,
    `WHATSAPP_SETTINGS_ID` in `lib/whatsapp-notify.ts`): `enabled` (the
    admin kill switch) and `connectionStatus`/`lastHeartbeatAt`, written
    exclusively by the worker so the admin page can show Connected /
    Disconnected / Needs QR re-scan without ever pinging the worker
    directly.
- **Enqueueing (Next.js side, `lib/whatsapp-notify.ts`) never throws.**
  `notifyResultsPublished`/`notifyLeaveNotice`/`notifyTimetableChange`
  each wrap their entire body in try/catch and swallow every error —
  a missing phone number, the feature being off, or a DB hiccup all just
  silently no-op. This is what makes the hook safe to `await` directly
  inside a core Server Action (publish, leave-notice create, timetable
  slot create/update/delete, whole-week build) without any extra
  try/catch at the call site: publishing results, for example, always
  succeeds regardless of whether WhatsApp is enabled, configured, or
  working. Enqueueing itself (one Prisma insert) is fast enough to just
  await rather than defer — the real "fire-and-forget" boundary is the
  SEND, which happens later, out-of-process, on the worker's own poll
  cycle.
- **Sending (VPS side, `whatsapp-service/`) is a separate deployable**
  with its own `package.json` — plain `pg` (not Prisma), so it never
  needs to track the main app's schema.prisma or run `prisma generate`.
  It polls `whatsapp_notification_logs` for `PENDING` rows, sends each
  via Baileys, and writes back `SENT`/`FAILED` + the error. See
  `whatsapp-service/README.md` for VPS setup, session persistence, and
  re-scanning the QR code.
- **Phone numbers live on the Student/Lecturer PROFILE, not User** —
  `Student.phoneNumber`/`Lecturer.phoneNumber`, both nullable. Deliberate:
  a Student often has no User at all (see Student registration below),
  but should still be able to receive notifications; keeping it at the
  same profile level for Lecturer (who always has a User) keeps the two
  symmetric. Notifications only ever send if the field is set —
  `PHONE_NUMBER_PATTERN` in `lib/whatsapp-notify.ts` is the one shared
  format validator (optional "+", 8-15 digits) used by every form that
  captures it (student registration + a small standalone "edit phone"
  dialog on the Students table, since there was no general student-edit
  form before this and most existing students were registered before
  the field existed; the Lecturer create/edit form under Admin -> Users).
- **Three trigger points**, each a thin hook at the end of an existing
  Server Action, never new business logic of its own:
  - `publishAssessment` (lecturer) -> `notifyResultsPublished` -> every
    student with a newly-PUBLISHED result on that assessment.
  - `createDailyLogEntry`, only when `type === "LEAVE_NOTICE"` ->
    `notifyLeaveNotice` -> whichever single party the entry names
    (`relatedLecturerId` or `relatedStudentId` — identical handling
    either way, same pattern the daily-log action itself already uses).
    NOTE/PROBLEM entries never notify.
  - `createTimetableSlot`/`updateTimetableSlot`/`deleteTimetableSlot`/
    `buildClassTimetable` -> `notifyTimetableChange` -> every current
    student of the affected class (one notification per class for the
    whole-week builder, not one per session).
- **Admin controls** live at `/admin/whatsapp` (nav-gated on the one
  `whatsapp.manage` permission, ADMIN-only — same "centrally
  administered" split as campus.manage/room.manage/shift.manage): an
  on/off toggle (`setWhatsAppEnabled`), a connection-status card (with
  client-side staleness detection — a heartbeat older than 2 minutes
  shows as "stale" even if the stored status still says CONNECTED, since
  the worker may have died without updating anything), and a paginated,
  filterable delivery log with per-row **Retry** on `FAILED` rows
  (`retryWhatsAppNotification` just flips the row back to `PENDING` for
  the worker's next poll — the admin page never talks to the worker
  directly, same DB-mediated coordination as everything else here). A
  second tab on the same page, **Notification Templates** (gated on its
  own `notification.templates.manage` permission — ADMIN-only,
  independent of `whatsapp.manage` so the two concerns, on/off vs.
  wording, can be granted separately), lets an admin customize the
  message text for each of the three triggers.
- **Message templates** (`WhatsAppMessageTemplate`, one row per
  `WhatsAppEventType`) hold the `templateText` sent for each trigger,
  with `{placeholder}` tokens filled in per recipient — e.g.
  `{studentName}`, `{mark}`, `{changeSummary}`. Seeded (migration
  `20260730010544_whatsapp_message_templates`) with the EXACT text each
  trigger hardcoded before this table existed, so nothing about an
  outgoing message changes until an admin deliberately edits one. The
  known placeholder set per event type is code, not data
  (`WHATSAPP_TEMPLATE_PLACEHOLDERS` in `lib/whatsapp-templates.ts`) —
  `updateWhatsAppTemplate` (`admin/whatsapp/actions.ts`) rejects a save
  containing any `{placeholder}` outside that set (real typo protection,
  e.g. `{studnetName}`, or a placeholder that's valid for a different
  event type), audited as `WHATSAPP_TEMPLATE_UPDATED` with old/new text;
  "Reset to default" (`resetWhatsAppTemplate`) restores
  `DEFAULT_WHATSAPP_TEMPLATES[eventType]` and audits
  `WHATSAPP_TEMPLATE_RESET` the same way. `lib/whatsapp-notify.ts`'s
  three notify functions fetch the effective template via
  `getEffectiveTemplate` — a 60s in-memory cache (same shape as
  `lib/permission-cache.ts`, explicitly invalidated right after a
  save/reset) so a fan-out (e.g. one call per student on a class-wide
  timetable change) hits the DB once, not once per recipient — then fill
  it with `fillTemplate`. **Fallback safety**: `getEffectiveTemplate`
  only ever returns a DB-stored template if it's non-blank AND uses only
  known placeholders for that event type; anything else (missing row,
  empty string, a placeholder that somehow became invalid, e.g. edited
  directly in the DB) falls back to the seeded default rather than risk
  a broken/literal `{typo}` reaching an outgoing message. The Templates
  tab's textarea shows the same available-placeholders list as clickable
  chips, a live preview (sample data, filled client-side via the same
  pure `fillTemplate`/`findUnknownPlaceholders` from
  `lib/whatsapp-templates.ts` — safe to import client-side since that
  module has no `prisma` import), and disables Save on an empty or
  invalid template. A user with `whatsapp.manage` but not
  `notification.templates.manage` sees the tab read-only (textarea
  disabled, Save/Reset hidden) rather than not seeing it at all — same
  "hide the controls, not the whole view" pattern as
  Campus/Room/Shift's own manage-vs-view split.

## Workload Excel import + auto-timetable generation

Two-step, entirely optional workflow that sits ON TOP OF the existing
manual tools — it never replaces or weakens the manual "Add Assignment" /
"Bulk Assign" forms or the drag-and-drop Build Timetable grid, which
remain fully functional and are the fallback path for anything this
workflow doesn't fully handle. The full setup order this workflow assumes
is: Academic Structure/Calendar → Course Plans (`ClassCoursePlan`) →
workload Excel import (creates `LecturerCourseAssignment` rows) →
optional sequential auto-timetable generation → manual drag-and-drop for
anything left unscheduled. Gated behind two independent permission keys,
`workload.import` and `timetable.generate` (seeded to ADMIN and DEAN —
same WHAT/WHERE split as `timetable.manage`: a Dean's run is scoped to
their own faculty's classes via `dean_departments`/`lib/dean-scope.ts`,
re-derived from the caller's role every call, never trusting which route
— `/admin/workload-import` or `/dean/workload-import`, same shared-panel
pattern as Daily Log/Timetable — got them there). Both keys are
independent on purpose (a caller could import workload without ever
generating, or vice versa).

- **Step 1 — Workload Excel import** (`admin/workload-import/`), THREE
  variants sharing one Tabs UI (`panel.tsx`) — **"By Semester
  (Recommended)"** is the default/primary tab, **"By Class"** a secondary
  one for a quick single-class fix, **"Bulk Import (Advanced)"** the
  original multi-class flow, kept unmodified for admins who prefer one
  free-form file across many classes at once. All three variants funnel
  into the SAME `finalizeWorkloadImport` helper (`actions.ts`) for the
  actual create/audit/summary work, so the success dialog and the
  "Continue to auto-generate timetable" handoff are byte-for-byte
  identical regardless of which one was used.
  - **By Semester (Recommended)** (`semester-actions.ts`,
    `semester-workload-import-client.tsx`): pick ONE OR MORE
    `Class.currentSemesterNumber` levels (`Checkbox` multi-select, e.g. 1
    and 3 together — options computed in `panel.tsx`'s
    `getSemesterNumberOptions`, itself just an aggregation over the SAME
    already-filtered class list `getWorkloadImportClasses` produces for
    the "By Class" tab, so the two pickers can never disagree about which
    levels are usable). `downloadSemesterWorkloadTemplate(semesterNumbers)`
    resolves EVERY class (dean-scoped) currently at one of the picked
    levels and builds ONE ROW PER (class, course) COMBINATION across all
    of them — `semester_level`/`class`/`course_code`/`course_name` all
    pre-filled straight from the DB (never freely typed); only `lecturer`
    and `credit_hours` are left blank. Course-plan rows are filtered to
    EXACTLY each class's OWN `currentSemesterNumber` (`getRelevantPlanRows`)
    — deliberately NOT just "any plan row at one of the selected levels",
    since `ClassCoursePlan` recurs per class across 1..8 and a class could
    coincidentally have a stray plan row filed under a DIFFERENT selected
    level too, which must never leak into that class's own rows.
    `previewSemesterWorkloadImport(semesterNumbers, formData)` re-validates
    anyway (defense in depth against a hand-edited file): `class` is
    matched ONLY within the resolved candidate set (dean scope + the
    picked levels — a class outside them is a real ERROR, "not among the
    selected semester levels"), `course_code` ONLY against THAT SPECIFIC
    resolved class's own plan at its own level (keyed by
    `${classId}:${courseCode}`, never a bare code lookup — a code
    belonging to a DIFFERENT selected class's plan is exactly as invalid
    as an unknown one), lecturer matched by staff number or full name,
    `credit_hours` must be a positive number, duplicate-in-file keyed by
    `(classId, courseId)`, and the same lecturer-conflict-is-an-ERROR rule
    as every other variant — same `finalizeWorkloadImport` handoff as
    Bulk Assign already uses for "one lecturer across many rows" (a
    lecturer appearing on multiple courses/classes across the selected
    levels in one file is completely normal, nothing special-cased).
    `confirmSemesterWorkloadImport(semesterNumbers, rows, fileName,
    errorsInFile)` re-resolves the candidate class set fresh — a row whose
    class fell out of scope since preview is silently dropped, not
    thrown, same "keep the rest of a large batch going" convention as the
    Bulk variant's own confirm — assembles the full `WorkloadImportRow`
    shape per row from its own resolved class's room/studyMode, and
    delegates to `finalizeWorkloadImport` in ONE transaction across every
    class/level in the file. The real academic-calendar Semester still
    defaults to whichever `Semester.isActive` is true (throws
    `NO_ACTIVE_SEMESTER` if none) — same convention as the By Class
    variant below, no separate semester picker. Selecting levels 1 and 3
    together here lines up directly with the sequential auto-timetable
    generator's own odd-level order (Step 2 below): confirm this import,
    hit Continue, generate semester 1, confirm it, generate semester 3.
    The success dialog's summary line (`ConfirmResultView`, shared by all
    three variants) now also shows "across N classes / M semester levels"
    whenever a result spans more than one class — computed from the
    created rows themselves, not a dedicated field, so the Bulk variant
    benefits too whenever it happens to span multiple classes.
  - **By Class** (`class-actions.ts`, `class-workload-import-client.tsx`,
    unchanged from when this was the primary/recommended tab — kept as
    the quick path for a one-off fix to a single class): pick ONE class
    first (`SearchableSelect`, dean-scoped, offering only classes with a
    current semester level AND at least one course actually planned at
    that level — computed in `panel.tsx`'s `getWorkloadImportClasses`, so
    the picker can never land on a class with an empty/blocked template).
    Both the real academic-calendar Semester (defaults to whichever
    `Semester` is currently `isActive` — same "defaults to the active
    semester" convention as the Assignments/Timetable/Reports pickers
    elsewhere in this app; throws `NO_ACTIVE_SEMESTER` if none) and the
    course-plan level (`Class.currentSemesterNumber`) are resolved
    automatically from the picked class — there is no semester column or
    picker at all. `downloadClassWorkloadTemplate(classId)` builds a
    template with ONE ROW PER COURSE already in that class's
    `ClassCoursePlan` at its current level (`course_code`/`course_name`
    pre-filled straight from the DB, never freely typed) — only
    `lecturer` and `credit_hours` are left blank. This is what makes "a
    course not in this class's plan can never appear as an option" hold
    structurally, not just by validation: the template is generated
    exclusively from the real plan, so there is no free-text "class"
    column through which a wrong-class/wrong-level course could ever be
    typed in the first place.
    `previewClassWorkloadImport(classId, formData)` re-validates anyway
    (defense in depth against a hand-edited file) — `course_code` is
    matched ONLY against courses in THIS class's plan at its current
    level (a code for a real course elsewhere in the system is exactly as
    invalid as an unknown one), lecturer matched by staff number or full
    name, `credit_hours` must be a positive number — same OK/
    `DUPLICATE_IN_FILE`/`ALREADY_EXISTS`/ERROR shape and same
    lecturer-conflict-is-an-ERROR rule as the other variants, just scoped
    to one class+semester instead of parsed per row.
    `confirmClassWorkloadImport(classId, rows, fileName, errorsInFile)`
    re-resolves the class (dean scope + current level) and the active
    semester fresh — never trusts anything round-tripped from the client
    — assembles the full `WorkloadImportRow` shape from that resolved
    context plus each narrow row, and delegates to
    `finalizeWorkloadImport`. To do MULTIPLE classes at once, the By
    Semester variant above is the recommended path now — this one stays
    for a single-class touch-up.
  - **Bulk Import (Advanced)** (`actions.ts`,
    `workload-import-client.tsx`, unchanged from when this was the only
    flow) — one file across many classes/courses/lecturers at once.
    Columns: `semester`, `program`, `class`, `course`, `lecturer`,
    `credit_hours`. Upload → Preview validates EVERY row server-side
    before any write (`previewWorkloadImport`), resolving each cell
    against the DB (semester by name, preferring the active one on an
    ambiguous match across academic years; program by code or name; class
    by name WITHIN that program, dean-scoped; course by code or name;
    lecturer by staff number or full name) and producing one of four
    statuses per row (same shared `ImportRowStatus` shape as every other
    bulk import in this app, no new status needed):
  - **OK** — everything resolves and there's no conflict.
  - **Error**, with the exact reason — unknown class, course not in that
    class's `ClassCoursePlan` for its CURRENT `currentSemesterNumber`
    level (never created for it), unknown lecturer, non-positive
    `credit_hours`, or a **lecturer conflict**: an assignment already
    exists for that course+class+semester with a DIFFERENT lecturer —
    this is an ERROR, not a silent overwrite, same "existing assignment
    with a different lecturer must be named and rejected" rule the
    manual Add Assignment / Bulk Assign forms already enforce.
  - **Duplicate in file** — every row sharing a (class, course, semester)
    key is flagged, not just the 2nd+ occurrence (same convention as
    every other bulk import here).
  - **Already exists** — an assignment already exists for that
    course+class+semester with the SAME lecturer: a harmless no-op, only
    ever skipped, never re-created or updated (credit hours on an
    existing assignment are never changed by re-importing).
  Confirm (`confirmWorkloadImport`) creates ONLY the OK rows, in one
  transaction (`BULK_TRANSACTION_OPTIONS`), setting the new
  `LecturerCourseAssignment.creditHours` field (nullable `Decimal(4,2)`,
  additive migration — every assignment created any other way, manual or
  bulk-assign, simply never sets it and is therefore not eligible for
  auto-generation) and auto-enrolling via the existing
  `autoEnrollClassIntoAssignment` (same as `createAssignment`/
  `bulkCreateAssignments`). Re-checks for conflicts immediately before
  writing (never inside the loop's catch, per the P2002-in-a-loop
  convention) and re-verifies every submitted class is still in the
  caller's dean scope — defense in depth, since confirm is a separate
  server call from preview and must never blindly trust round-tripped
  ids. Audited as `WORKLOAD_IMPORTED` with row counts and filename. After
  Confirm, a SUCCESS DIALOG (never silent, never auto-advancing) shows
  "Course assignments created: X new, Y skipped, Z errors," a summary
  table of the newly created assignments (lecturer, course, class,
  semester, credit hours), and two explicit buttons: **Done** (closes the
  dialog — assignments are saved, nothing else happens, schedule manually
  later via the existing tools) and **Continue to auto-generate
  timetable** (only shown when the caller also holds
  `timetable.generate` and at least one assignment was actually created)
  — proceeding to Step 2 with exactly those newly-created assignments,
  never a broader set.
- **Step 2 — sequential auto-timetable generation**
  (`admin/auto-timetable/`, only ever entered from Step 1's own success
  dialog — there is no separate nav entry for it). **Permanent workflow
  rule**: the generator ALWAYS processes the newly-created assignments
  ONE `Class.currentSemesterNumber` LEVEL at a time (this is the batch's
  cohort level, 1..8 — a completely different number from
  `Semester.semesterNumber`, see the "Add/Edit Semester" bullet above;
  never conflate them), starting from the LOWEST ODD number present (1,
  then 3, then 5, then 7 — never even, never all levels in one run, never
  configurable to a different order without an explicit future request).
  Assignments for classes at an EVEN level are simply never
  auto-generated — shown as an informational note, left for manual
  scheduling. Flow: the success dialog's "Continue" button opens the
  generator for the FIRST odd level found → the generator reads each
  class's room directly off `Class.roomId` (room is a class-registration
  property — see the "Class Timetable" business rule's "room is a
  class-registration property" bullet below — never picked here; a class
  with no room set is reported upfront with a direct link to set one and
  its assignments are excluded from this batch's scheduling, never
  guessed) →
  **Generate preview** (`previewAutoTimetableBatch`, a pure read, NO
  writes) → a results screen with three clearly separated sections → an
  explicit **Confirm this semester** button → ONLY on that click does
  `confirmAutoTimetableBatch` write `TimetableSlot` rows for that level's
  classes, in one transaction → the UI then offers "Generate semester
  [next odd number]" as a separate explicit action — it never
  auto-advances. The preview is fully re-runnable and discardable per
  level (tweak shift-override choices and regenerate as many times as
  wanted — room is fixed per class, not a per-run choice) — nothing is
  written until that level's own Confirm click,
  and a later level is never offered before the current one has been
  confirmed (enforced by the generator's own client-side state machine).
  - **Session length is derived ONLY from Shift templates that already
    exist** — `lib/auto-timetable.ts`'s `findClosestShiftCombo` NEVER
    invents a new time range. For each assignment,
    `creditHours ÷ existing shift lengths` picks the multiset of real
    Shift records (for the class's studyMode) whose combined duration
    comes closest to `creditHours` (e.g. 3 → two 1.5h shift-sessions;
    2.5 → one 2.5h shift-session), preferring an exact match and, among
    exact matches, the fewest sessions. When no combination sums exactly,
    the CLOSEST achievable total is used and the assignment is flagged
    with the precise shortfall/excess (e.g. "2.5 credit hours requested,
    3.0 scheduled using two 1.5h shifts — 0.5h over, review
    recommended") rather than silently accepted. An optional
    per-assignment shift-combination OVERRIDE lets the admin/dean pick a
    specific set of shifts instead of the auto-picked combo, for genuine
    edge cases — day placement below still runs identically either way.
  - **Spacing rule (default, strict) + fallback (last resort, always
    flagged)**: the same course+lecturer combination gets AT MOST ONE
    session per day — `generateTimetableForBatch` tries every OTHER
    valid day for that class (per its FT/PT `studyMode`) BEFORE ever
    reusing a day already used by that same assignment (pass 1: unused
    days only). Only when pass 1 places nothing (every unused valid day
    conflicts) does pass 2 allow a second session on an already-used day,
    provided a DIFFERENT time there is genuinely conflict-free — the
    exact same time on that day is impossible by construction, since it
    would self-conflict as a CLASS/LECTURER hit against the session
    already placed there. Every time the fallback fires, it's added to
    the results screen's own "Scheduled with spacing fallback — review
    recommended" section with a specific flag message (e.g. "Arabic
    Language double-booked on Saturday because no other valid day had
    room — review recommended") — this must never happen silently, and
    never happens at all unless every other valid day for that class was
    genuinely unusable.
  - **Hard conflict rules — NEVER violated, no fallback overrides these**:
    reuses the EXACT SAME pure `findTimetableConflicts` function the
    manual single-slot Add/Edit dialog and the drag-and-drop Build
    Timetable already use — no new conflict algorithm, just a new caller.
    No lecturer double-booked at the same day+time across ANY class or
    faculty (candidates are fetched via the existing
    `getConflictCandidates(semesterId)`, which — because all levels
    processed in one generation run share the SAME real `Semester` row —
    already includes every TimetableSlot from an earlier, already-
    confirmed level in this same run, with zero special-casing needed).
    No room double-booked by a different class. No class double-booked
    with itself. Only the days valid for the class's studyMode are ever
    used (`lib/timetable-days.ts`, unchanged). Anything that can't be
    placed even via the fallback, without breaking a hard rule, lands in
    the results screen's third section, "Unscheduled — needs manual
    placement," with a specific reason (e.g. "No valid day/shift remains
    without conflicting with an existing booking") — NEVER force-placed,
    NEVER silently dropped.
  - `confirmAutoTimetableBatch` re-validates every session against FRESH
    conflict candidates immediately before writing (time may have passed
    since the preview) and writes via one `timetableSlot.createMany`
    inside a transaction — any session that raced into a genuine conflict
    since the preview is skipped (reported as
    `skippedDueToRaceConflict`) rather than force-written. Audited as one
    `AUTO_TIMETABLE_GENERATED` entry per confirmed level (semester,
    level, created/skipped counts) — matching the existing
    one-summary-entry-per-batch-operation convention (BULK_ASSIGNED,
    TIMETABLE_WEEK_BUILT). Triggers the SAME `notifyTimetableChange`
    WhatsApp hook as every other timetable mutation, once per affected
    class (never per session) — generated sessions are indistinguishable
    from manually created ones to students/lecturers.
  - The results screen also links directly into the existing Timetable
    page (filtered to the affected class/semester) so anything flagged
    can be reviewed or adjusted by hand before or after confirming — the
    drag-and-drop Build Timetable grid, the single-slot Add/Edit dialog,
    and Bulk Assign are completely unmodified by this feature.

## Conventions

- Server Actions live in `app/**/actions.ts`, always "use server", always
  validate input with Zod, always auth-check first.
- Auth helpers in `lib/auth.ts`: getCurrentUser(), requirePermission(key),
  getUserAccess(userId), getSessionContext() (user + permissions +
  roleNames in one call, for layouts), requireAssessmentOwner(assessmentId),
  requireAssignmentOwner(assignmentId). requireRole no longer exists —
  see the Authorization model section.
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
- Never call `argon2.hash` (or any other deliberately slow/CPU-bound work)
  inside a `prisma.$transaction(...)` callback, especially in a loop over
  multiple rows. argon2id is intentionally slow — hashing N rows'
  passwords one-by-one inside the transaction can push the elapsed time
  past Prisma's interactive-transaction timeout (default 5s), which
  aborts the whole batch with "Transaction already closed: A query cannot
  be executed on an expired transaction" once a handful of rows are being
  created at once. Hash every row's password BEFORE opening the
  transaction (in parallel via `Promise.all` — argon2's native binding
  runs on libuv's threadpool, so this is a genuine concurrency win, not
  just cosmetic), then have the transaction do only the fast DB writes.
  See `admin/student-accounts/actions.ts`'s `generateAccountsForClass`
  and `admin/users/bulk-import-actions.ts`'s `confirmLecturerImport` for
  the pattern — both were fixed from the original hash-inside-transaction
  bug. When doing this, keep each row's generated temp password and its
  hash as one paired value carried into the transaction — regenerating a
  second random password to hash separately from the one shown to the
  admin silently breaks that account's login (a bug caught during this
  exact fix's own review, never shipped).
  Moving hashing out is necessary but not sufficient on its own — ANY
  interactive `prisma.$transaction(async (tx) => ...)` that loops over a
  variable-sized batch (not just ones with hashing in them) risks the
  same class of failure purely from accumulated round-trip time once the
  batch is large enough, especially over Neon's pooled `DATABASE_URL`
  connection (pgbouncer-style transaction pooling is known to be less
  forgiving of long-running interactive transactions than a direct
  connection). Every such call passes an explicit second argument,
  `BULK_TRANSACTION_OPTIONS` (`lib/db.ts`: `{ timeout: 30000, maxWait:
  10000 }`), as a safety margin above Prisma's defaults (5s timeout, 2s
  maxWait) — sized for the largest realistic batch, not tuned per
  call site. Audited and applied to every batch-looping interactive
  transaction in the codebase: `admin/users/bulk-import-actions.ts`
  (`confirmLecturerImport`), `admin/student-accounts/actions.ts`
  (`generateAccountsForClass`), `admin/students/bulk-import-actions.ts`
  (`confirmStudentImport`), `admin/semesters/actions.ts`
  (`openSemester`), `admin/assignments/actions.ts`
  (`bulkCreateAssignments`). Single-row/bounded transactions (one user,
  one student, one assignment, role/permission CRUD, enrollment
  transfer) were deliberately left alone — they're already fast and
  don't need the margin. If this explicit timeout alone doesn't resolve
  a transaction failure on a real batch, the next escalation is routing
  that specific `$transaction` through a `DIRECT_URL`-backed client (or
  restructuring away from an interactive transaction toward a single
  batched `createMany`/`updateMany` plus app-level pre-checks, the same
  pattern the P2002-in-a-loop rule above already establishes) — not a
  blanket switch of `DATABASE_URL` itself.
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
- Admin nav is 6 grouped hub pages (each a tabbed route, tab state in the
  `tab` query param) instead of one link per sub-resource:
  `/admin/structure` (Departments | Programs | Classes),
  `/admin/calendar` (Academic Years | Semesters),
  `/admin/curriculum` (Courses | Course Plans | Assignments),
  `/admin/students` (Students | Student Accounts | Enrollments |
  Transfer Students — this hub reuses the `/admin/students` path itself,
  since "Students" is both the hub and one of its own tabs),
  `/admin/lecturers` (Lecturers | Lecturer Accounts — same
  self-referencing-tab pattern, mirroring `/admin/students`; see the
  "Lecturer registration split" roadmap entry), and `/admin/campuses`
  (Campuses | Rooms — same pattern again; see the "Campus & Room
  management moved to its own section" roadmap entry). `/admin/users`,
  `/admin/timetable`, and `/admin/daily-log` stay standalone
  single-purpose pages (the latter two
  have their OWN internal `Tabs`, e.g. Timetable's Timetable/Build/Shifts, but
  that state is local component state, not a `HubTabs`-driven URL param —
  don't confuse the two patterns). Each sub-resource
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
  (label, href, icon, optional `permissions: PermissionKey[]` — visible
  if the user holds ANY of them; omitted = every authenticated user), and
  `AppShell` filters it against the session's effective permission set
  (passed down from `getSessionContext()` in `app/(app)/layout.tsx`).
  Adding/removing a link is a one-line change there — never hardcode a
  link list in a component, and never key visibility on a role name.
  There is ONE generic "Dashboard" entry (href `/`) for everyone — `/`
  itself redirects DEAN to `/dean` and STUDENT to `/student`, so no
  per-role dashboard rows are needed. Dean is the one section that does
  NOT use the admin hub/tab
  pattern — Ownership Transfer and Reports are separate top-level
  links/routes rather than tabs inside one page, because they're peer
  administrative tools a Dean jumps between directly, not sub-views of one
  resource the way e.g. Academic Years/Semesters are both "the calendar."
  (Close Semester used to be a third such link; it's now a global Admin
  calendar action instead — see the "Close semester moves from Dean to
  Admin" roadmap entry.) The underlying `panel.tsx`/`actions.ts`/
  `*-client.tsx` per feature are unchanged from when it was a hub — only
  routing changed (each panel now renders under its own standalone
  `page.tsx` with its own `PageHeader`, and each feature's `revalidatePath`
  points at its own route instead of the old shared `/dean`).
- Every role's `/`-or-equivalent landing page is a real, read-only,
  data-backed dashboard, never a placeholder — ADMIN and LECTURER share
  the generic `app/(app)/page.tsx` (branches on role NAMES with priority
  ADMIN > DEAN > LECTURER > STUDENT — presentation only — since they
  don't redirect away from `/`); STUDENT (`/student/page.tsx`) and DEAN
  (`/dean/page.tsx`) already redirect there from `/`, so their dashboards
  live at their own root page. ADMIN: student/lecturer/active-class counts
  + active semester name, a recent-audit-log table (last 8 `AuditLog`
  rows), quick links (Add user, Register student, Open semester,
  Assignments). LECTURER: assigned-course count, a table of DRAFT
  assessments still needing to be published (title, course/class, a
  direct "Enter results" link per row) — scoped through
  `assignment: { lecturer: { userId } }`, the same ownership pattern used
  everywhere else in the lecturer module — plus, if they hold
  `dailylog.view.own`, a "My Leave Notices" read-only widget (see the
  Faculty Daily Log bullet). STUDENT: added a "Latest
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
  Ownership Transfer, Close Semester, Reports — Close Semester was later
  moved to Admin, see the "Close semester moves from Dean to Admin"
  roadmap entry below) — the `panel.tsx`/`actions.ts` per feature are
  untouched, only routing/`revalidatePath` changed; old `?tab=` URLs
  redirect. `nav-items.ts` gained the three new DEAN-scoped links and
  excluded DEAN from the generic "Dashboard" entry to avoid a
  duplicate-labeled row. All four roles now land on a real, read-only,
  data-backed dashboard instead of a placeholder — see the nav config
  bullet above for exactly what each role's dashboard shows.
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

Phase 7: RBAC + granular overrides (branch `feature/permissions`) — the
  fixed 4-role enum replaced by Role/Permission/RolePermission/UserRole/
  UserPermissionOverride tables. 22-key permission catalog in
  `lib/permissions.ts` (mirrored into the DB by migration
  `20260709120000_rbac_permissions` and prisma/seed.ts); every Server
  Action converted from requireRole to requirePermission(key) with
  ownership/status checks unchanged on top; data-preserving migration
  seeded the 4 system roles with EXACTLY their pre-RBAC effective access
  and copied every user's enum role into a user_roles row before
  dropping the column. Effective permissions (union − DENY + GRANT)
  cached 60s in-memory with explicit invalidation. Sidebar/layouts now
  permission-driven; role names kept for presentation only. New
  Roles & Permissions tab under /admin/users (role CRUD with permission
  matrix; per-user multi-role + overrides dialog with live effective-
  permissions preview); lockout guards SELF_LOCKOUT/LAST_USER_MANAGER
  enforced in-transaction; ROLE_*/USER_ACCESS_UPDATED audit actions.
  Tests: `lib/permissions.test.ts` (permission math, DENY-wins,
  multi-role union, seed-grant parity pinning the 8 security rules),
  `admin/roles/actions.test.ts` (system-role immutability, lockout
  rollbacks), last-manager guard on deactivateUser — plus all 13
  existing action test files migrated to the requirePermission mock —
  DONE, merged to main (feature/permissions fast-forwarded, 2026-07-11)

Post-Phase-7 addition — Student results redesign (branch
  `feature/student-results-redesign`): restyled the student-facing results
  UI to the "Academic Clarity" visual language (progress hero + assessment
  cards on mobile, richer desktop layout, compact Semester Overview table),
  reusing the existing published-only ownership-scoped queries rather than
  changing any scoring logic. New routes `/student/results` (recently
  published marks + course list, replacing the old dashboard course table),
  `/student/results/[enrollmentId]` (moved from `/student/courses/…`, which
  now redirects), and `/student/overview` (active/completed counts using
  real `EnrollmentStatus` values, combined CA average, per-course progress
  bars). Two new ownership-scoped queries in `student/queries.ts`
  (`getRecentPublishedMarks`, `getStudentSemesterOverview`) and a new
  `exportMyResults` Server Action (`student/actions.ts`) for a student's own
  results as an xlsx download, reusing the Dean-reports xlsx pattern.
  Investigation found: the CA model is 100% CA with no fixed cap (no exam
  split, no course-level max — lecturers set their own weights), so the
  hero shows the real computed denominator rather than a hardcoded "/100";
  GPA is not implemented anywhere in the schema and was deliberately left
  out rather than fabricated; credits, grade prediction, and deadline/
  schedule UI from the design mockups were dropped as out of scope. Nav
  sidebar's old single "My Courses" entry split into "Results" and
  "Semester Overview" (`nav-items.ts`), reusing the shared AppShell rather
  than a bespoke student-only chrome. Tests extended in `queries.test.ts` +
  new `actions.test.ts`. Not yet visually verified in a browser — querying
  the shared DB for a real student account to log in as was blocked by the
  environment's PII-handling guard, so this needs a manual check (see the
  testing plan handed to the user) before merging.

Business rule change — Close semester moves from Dean to Admin (branch
  `feature/student-results-redesign`): closing the semester is now a
  global Academic Calendar action, not a Dean tool. `semester.close`'s
  default grant moved from DEAN to ADMIN in `DEFAULT_ROLE_GRANTS`
  (`lib/permissions.ts`), with a data migration
  (`20260718000000_close_semester_to_admin`) re-granting it on existing
  databases (system roles only — any custom role or per-user override an
  admin has since configured is left untouched). The feature itself moved
  from the standalone `dean/close-semester/` page into Academic Calendar >
  Semesters as an action on the active semester's row (`admin/semesters/
  actions.ts`'s `closeSemester`, `semesters-client.tsx`'s confirm dialog)
  — behavior is byte-for-byte the same as before (counts, the
  still-unpublished-drafts warning, one transaction setting
  Semester.is_closed + closing every DRAFT/PUBLISHED assessment,
  SEMESTER_CLOSED audit log), only the actor and the entry point changed.
  `dean/layout.tsx`'s section guard and `nav-items.ts` no longer reference
  `semester.close`; the legacy `/dean?tab=close-semester` redirect now
  forwards to `/admin/calendar?tab=semesters` instead of a Dean route. No
  per-faculty close-semester scoping exists in this codebase (there is no
  `Faculty` entity and `Semester.is_closed` is a single global boolean) —
  the Open Semester wizard's "previous semester not closed" warning
  already read that same global boolean, so it needed no change. Dean's
  scope is now exactly ownership transfer + reports + dashboard.

Business rule change — Faculty-scoped deans (branch
  `feature/dean-scoping`): deans are no longer university-wide — each
  dean oversees zero, one, or many Departments ("faculty" =
  `Department` in this schema, confirmed as the only such concept; there
  is no separate `Faculty` entity), via a new `dean_departments` join
  table (schema-only migration `20260720000000_dean_departments`, no
  backfill — every existing dean starts unassigned). A dean's visible/
  actionable universe = classes whose Program belongs to one of their
  departments, plus everything under those classes (students,
  enrollments, LecturerCourseAssignments, assessments, results, and the
  lecturers currently teaching them). One reusable module,
  `lib/dean-scope.ts` (`getDeanDepartmentIds` + a family of
  where-builders composed from one base predicate), is applied to every
  dean-facing query and action: ownership transfer's assignment list AND
  server-side lookup, its "new lecturer" picker AND validation (scoped to
  lecturers already visible to that dean), all three reports (course/
  class/student — student history additionally scoped per-enrollment,
  not just via current class), and the dashboard's assessment counts
  (`dean/queries.ts`). An unassigned dean sees a "No faculties assigned
  yet" empty state everywhere instead of all data — this falls out of the
  scoping mechanism itself (Prisma's `{ in: [] }` matches nothing), not a
  special case bolted on top. Every scoped lookup uses the
  "ownership-check-IS-the-query" idiom (`findFirst` with the scope in the
  `where`, never a separate check after `findUnique`), so an id from
  another faculty returns NOT_FOUND rather than leaking its existence.
  Permissions (`ownership.transfer`, `reports.view.all`) are completely
  unchanged — they still define WHAT a dean can do; `dean_departments`
  only adds WHERE. Managed from Admin -> Users: a new "Faculties
  overseen" `...`-menu item (DEAN rows only) opens a checkbox-list dialog
  (`admin/users/dean-departments-dialog.tsx`) calling
  `updateDeanDepartments` (`admin/roles/actions.ts`, gated on
  `roles.manage`, same replace-all-in-a-transaction pattern as
  `updateUserAccess`), audited as DEAN_FACULTIES_CHANGED with old/new
  department-name lists. A DEAN+LECTURER multi-role user's two scoping
  systems are fully independent (dean_departments never touches the
  lecturer-side `lecturer: { userId }` ownership queries, and vice versa)
  — see `dean/dean-lecturer-multirole.test.ts`. New/updated tests:
  `lib/dean-scope.test.ts`, `dean/transfers/actions.test.ts`,
  `dean/reports/queries.test.ts`, `dean/queries.test.ts`,
  `admin/roles/actions.test.ts`, `dean/dean-lecturer-multirole.test.ts`.

Business rule change — Auto-generated batch codes (branch
  `feature/batch-code-autogen`): `batchCode` is no longer free-typed on
  class creation — it's derived from the selected Program's `code` + the
  last 2 digits of a new "Intake year" input (the batch's starting/
  cohort year), e.g. program "CMS" + intake 2026 -> "CMS26". `Class`
  gains a nullable `intakeYear` column (migration
  `20260721000000_class_intake_year`, additive only, no backfill —
  existing classes keep their original manually-typed batchCode exactly
  as is, with intakeYear simply unset for them). `admin/classes/
  actions.ts`'s `composeClassData` computes batchCode server-side from a
  fresh Program lookup (never trusts a client-submitted batchCode) and
  only recomputes it when intake year/section/study mode are explicitly
  present/edited — otherwise falls back to the pre-existing manually-
  typed `name` escape hatch for legacy/edge-case classes, unchanged.
  Uniqueness (batchCode+section+studyMode, i.e. the composed `name`) is
  now pre-checked with a friendly conflict message instead of relying on
  the raw DB constraint. `admin/classes/classes-client.tsx`'s form
  replaced the free-text batchCode `Input` with an "Intake year" number
  input (defaults to the active AcademicYear's start year, editable) plus
  a read-only live "Batch code: CMS26" preview computed the same way as
  the server. Investigation found no OTHER manual batchCode entry point
  anywhere in the app to update: Students bulk import's `class_code`
  column already matches against `Class.name` (an existing class), never
  a typed batchCode, and Courses/Lecturers bulk import don't reference
  classes at all. New `admin/classes/actions.test.ts` (didn't exist
  before this phase) covers the derivation, the intake-year-missing
  fallback, and the duplicate-name pre-check for both create and update.

New feature — Faculty Daily Log (branch `feature/daily-log`, built on
  top of the merged `feature/dean-scoping` + `feature/batch-code-autogen`
  work, since it reuses `dean_departments`/`lib/dean-scope.ts` directly):
  a new `DailyLogEntry` model (departmentId, authorId, type
  [LEAVE_NOTICE|PROBLEM|NOTE], nullable relatedLecturerId, title,
  description, entryDate — migration `20260722000000_daily_log_entries`)
  for notes/leave notices/problems logged against a faculty. Two new
  permission keys, `dailylog.create`/`dailylog.view`, seeded to BOTH
  ADMIN and DEAN (migration `20260722010000_dailylog_permissions`) —
  deliberately shared, since permissions are WHAT and dean_departments is
  WHERE. Lives at `/admin/daily-log` AND `/dean/daily-log`, but is
  genuinely ONE implementation: both routes render the same
  `admin/daily-log/panel.tsx` (`dean/daily-log/page.tsx` imports it
  directly, no separate Dean panel file). Because the permission is
  shared, the route split can't be trusted as the scoping boundary by
  itself — `getDailyLogPanelData` and `createDailyLogEntry` both
  re-derive the real boundary from the caller's actual ROLE
  (`getUserAccess(userId).roleNames.includes("DEAN")`) on every call: a
  pure ADMIN gets/writes any faculty, a DEAN (including a DEAN+ADMIN
  multi-role user) always gets exactly their own `dean_departments`
  scope via a new `dailyLogDeanWhere` in `lib/dean-scope.ts` (direct
  `departmentId` filter — `DailyLogEntry` has no Class/Program nesting
  like the rest of that module). The leave-notice lecturer picker/
  validation was INITIALLY scoped through the existing `lecturerDeanWhere`
  too, but manual testing found a real bug: that helper means "lecturers
  currently holding an assignment in-scope", so a faculty with zero
  active assignments yet (a new/quiet department, or between semesters)
  showed no pickable lecturers at all — the picker was unusable exactly
  when it mattered. Fixed by NOT scoping the lecturer list/validation by
  faculty at all (there's no Lecturer->Department relation in the schema
  to scope by in the first place) — every active lecturer is offered to
  both ADMIN and DEAN; the entry's own `departmentId` (still fully
  dean-scoped) is the real security boundary, not which lecturer gets
  named inside it. Minimal-friction leave notices: picking `type =
  LEAVE_NOTICE` swaps the dialog's Title field
  for a lecturer `SearchableSelect`, and the server derives the title
  from the lecturer's name server-side rather than asking for one to be
  typed — one shared dialog component, not two forms, with a "Quick
  leave notice" button that's just the same dialog pre-set to that type.
  List view reuses the existing pagination/filter toolkit (search, type,
  faculty — hidden unless there's more than one to choose from, date).
  Audited as DAILYLOG_CREATED. No edit/delete — append-only, nothing in
  the spec asked for it. Tests: `lib/dean-scope.test.ts` gained
  `dailyLogDeanWhere` coverage; new `admin/daily-log/actions.test.ts` and
  `admin/daily-log/queries.test.ts` cover the ADMIN-vs-DEAN-vs-
  unassigned-DEAN-vs-multi-role role branching on both the read and
  write side.

Follow-up fix — Daily Log leave-notice picker was empty for a quiet
  faculty: it had been scoped via `lecturerDeanWhere` (lecturers
  currently holding an assignment in-scope), so a faculty with zero
  active assignments yet showed no pickable lecturers at all (found via
  manual testing — see the "lecturer picker/lookup is deliberately
  UNSCOPED by faculty" bullet above for the fix and reasoning).

Extension — LECTURER read-only "My Leave Notices": a lecturer can now
  see their own leave notices (never the full faculty log, never write)
  via a new `dailylog.view.own` permission key seeded to LECTURER only
  (migration `20260723000000_dailylog_view_own`) — same "view.own" shape
  as `results.view.own`/`reports.view.own`/`assessment.view.own`.
  `getMyLeaveNotices` (`admin/daily-log/queries.ts`) scopes via
  `relatedLecturer: { userId }` directly (the query IS the ownership
  check). Surfaced as a small read-only "My Leave Notices" table (5 most
  recent) on the shared Lecturer dashboard (`app/(app)/page.tsx`'s
  `LecturerOverview`), gated on holding the permission — matches the
  existing "Drafts not yet published" section's exact visual pattern in
  the same component. New tests in `lib/permissions.test.ts` (LECTURER
  holds `dailylog.view.own` and nothing broader) and
  `admin/daily-log/queries.test.ts` (`getMyLeaveNotices` scoping).

Extension — Daily Log NOTE/PROBLEM can optionally reference a student:
  new nullable `relatedStudentId` on `DailyLogEntry` (migration
  `20260724000000_dailylog_related_student` — a REAL migration was
  needed: the request claimed this field already existed, it did not;
  verified against schema.prisma directly before writing anything).
  NOTE/PROBLEM only, never LEAVE_NOTICE (that stays `relatedLecturerId`-
  only, unchanged); optional — most notes/problems aren't about a
  specific student. Unlike the LEAVE_NOTICE lecturer picker,
  `relatedStudentId` IS dean-scoped via the existing `studentDeanWhere`
  (both `createDailyLogEntry`'s validation and the picker's option list
  in `getDailyLogPanelData`) — a student always has a real home
  department through `class -> program`, so there's no "quiet faculty"
  empty-picker risk the way there was for lecturers. Display: the list
  table's "Lecturer" column became "Related" and shows whichever of
  lecturer/student is set, reusing the existing single-column/"—"-
  fallback rendering rather than adding a mostly-empty second column.
  **Student-facing visibility was explicitly NOT changed** — the
  request's premise that a student-facing `dailylog.view.own` already
  existed, scoped by `relatedStudentId`, was false (verified directly:
  STUDENT holds only `results.view.own`, no Daily Log permission of any
  kind). Nothing was added for STUDENT here, per the request's own
  instruction to ask first rather than silently exposing PROBLEM/NOTE
  entries to students. New tests in `admin/daily-log/actions.test.ts`
  (optional student reference, dean-scoped lookup, LEAVE_NOTICE never
  touches it) and `admin/daily-log/queries.test.ts` (student list
  scoping in the panel data).

Follow-up fix — LEAVE_NOTICE gained the same lecturer-or-student "About"
  toggle PROBLEM/NOTE already had (previously LEAVE_NOTICE was
  lecturer-only, an inconsistency reported as a bug): `createDailyLogEntry`
  no longer branches on `data.type` for who-lookup at all — it branches on
  which of `relatedLecturerId`/`relatedStudentId` was actually submitted,
  uniformly for all three types (lecturer lookup stays unscoped, student
  lookup stays `studentDeanWhere`-scoped, exactly as already decided for
  NOTE/PROBLEM). The UI's old `type === "LEAVE_NOTICE" ? lecturer-only :
  title+optional-student` branch was replaced with ONE shared
  `RelatedPersonField` component (Title field now always renders for
  PROBLEM/NOTE only, independent of the About toggle, which renders for
  all three). No schema change, no migration — `relatedStudentId` already
  existed from the prior phase; this was purely wiring it into the
  LEAVE_NOTICE path. Re-confirmed (not re-decided) the student-visibility
  answer from the prior phase: still nothing added for STUDENT — no
  `dailylog.view.own` grant exists for STUDENT, so a LEAVE_NOTICE about a
  student is exactly as invisible to that student as a PROBLEM/NOTE about
  them already was; this phase did not touch that question. New tests:
  a LEAVE_NOTICE about a student derives its title from the student's
  name and is dean-scoped the same as NOTE/PROBLEM; submitting both a
  lecturer AND a student, or neither, on a LEAVE_NOTICE is rejected by
  the Zod schema.

Bug report investigated — root cause: no student-facing Daily Log
  feature had ever been built (not a wiring bug in an existing feature).
  A "student's My Leave Notices widget shows nothing even though a real
  LEAVE_NOTICE with relatedStudentId exists" report turned out to
  describe a widget/query/permission that simply didn't exist yet —
  verified directly (grep found zero references to `relatedStudentId`/
  `getMyLeaveNotices`/"My Leave Notices" anywhere under `app/(app)/
  student/`, and `DEFAULT_ROLE_GRANTS.STUDENT` was still exactly
  `["results.view.own"]`) before writing anything, per the standing
  investigate-before-fixing/confirm-before-scope-changes instructions
  from the prior two phases. Reported this finding and asked directly:
  build the student-facing feature now, or leave STUDENT with zero Daily
  Log access as originally decided? Confirmed: build it. Implementation
  exactly mirrors the LECTURER exception documented above —
  `dailylog.view.own` extended to STUDENT (migration
  `20260727000000_dailylog_view_own_student`, additive: `dailylog.view.own`
  already existed as a permission row from the LECTURER migration, this
  only adds the STUDENT role_permissions grant), a new
  `getMyLeaveNoticesForStudent` sibling function in `admin/daily-log/
  queries.ts` scoped through `relatedStudent: { userId }`, and a "My
  Leave Notices" widget on `app/(app)/student/page.tsx` gated on the
  permission — same shape as the lecturer version, not a new pattern.
  This is a deliberate, explicitly-confirmed exception to NON-NEGOTIABLE
  SECURITY RULE 4 ("STUDENT's seed grant is exactly results.view.own,
  nothing else") — the rule's text was updated in place (not removed) to
  describe the extension as intentional and to require the same
  explicit-confirmation bar for any future addition to STUDENT's grants.
  Verified end-to-end against the real dev-DB row reported in the bug
  (a genuine LEAVE_NOTICE for student "ahmed") — the fixed query now
  returns it for that student's actual session userId. New regression
  test in `admin/daily-log/queries.test.ts` pins exactly this scenario
  (a real LEAVE_NOTICE row surfaces for the student it names); permission
  tests updated to assert STUDENT's exact two-key grant list instead of
  the old one-key list.

New feature — Class Timetable (branch `feature/timetable`, branched off
  the merged `feature/daily-log` lineage since it reuses
  `lib/dean-scope.ts` directly): scheduling of course + lecturer + day +
  time + room per class/semester, with server-side conflict detection.
  Two new models — `Room(id, name, capacity nullable, deletedAt)` and
  `TimetableSlot(id, lecturerCourseAssignmentId, dayOfWeek [MON..SAT],
  startTime, endTime, roomId)`, migration `20260727010000_timetable` — plus
  three permission keys (`timetable.manage`/`timetable.view` to ADMIN+DEAN,
  `timetable.view.own` to LECTURER+STUDENT), migration
  `20260727020000_timetable_permissions`. Conflict detection
  (`lib/timetable-conflicts.ts`) is a pure function reused by both the
  real blocking pre-check and a live inline-preview action, covering three
  rules (same room / same lecturer / same class, all requiring a genuine
  day+time overlap within the same semester) and collecting every conflict
  found rather than stopping at the first. `/admin/timetable` and
  `/dean/timetable` share one panel exactly like Faculty Daily Log (one
  implementation, two routes, scope re-derived from the caller's role
  every call via `assignmentDeanWhere`/`classDeanWhere`, reused not
  duplicated); a "Rooms" tab on the same page is simple unscoped CRUD.
  Lecturer and Student each got a dedicated read-only page (not a
  dashboard widget, since a weekly grid is too large for one) rendering a
  new shared `components/timetable/weekly-grid.tsx` with edit/delete
  handlers omitted for read-only viewers.
  `getMyTimetableForStudent` resolves the student's own ACTIVE enrollments
  first (no direct schema relation from enrollment to assignment) and
  matches slots via the resulting course+class+semester tuples. Audited as
  `TIMETABLE_SLOT_CREATED`/`_UPDATED`/`_DELETED`. New tests:
  `lib/timetable-conflicts.test.ts` (pure overlap/conflict-kind logic),
  `admin/timetable/actions.test.ts` (permission gate, dean-scoping on both
  the assignment and the existing slot, all three conflict rules blocking,
  audit calls), `admin/timetable/queries.test.ts` (panel data ADMIN/DEAN/
  unassigned-DEAN/multi-role scoping, semester-default/`"all"` filter
  behavior, lecturer/student own-schedule ownership scoping);
  `lib/permissions.test.ts`'s STUDENT/DEAN exact-grant-list pins updated
  to include the three new keys.

Extension — Bulk room creation (branch `feature/timetable`): a "Bulk add
  rooms" dialog alongside the existing single Add-room form on the
  Timetable page's Rooms tab, gated on the same `timetable.manage`
  permission (no new permission key needed). Two entry modes — "Paste
  list" (textarea, one name per line) and "Number range" (prefix + start +
  end + optional capacity, e.g. prefix "Room 1" + "01".."20" -> "Room
  101".."Room 120", zero-padding width inferred from the typed start
  number's digit count, pure client-side generation via
  `admin/timetable/rooms/range-generator.ts`, no server round-trip needed
  just to build the candidate list) — both flatten to the same `{name,
  capacity?}[]` shape feeding one shared Preview -> Confirm flow, same
  spirit as the existing Bulk Import toolkit though a bespoke
  implementation (this isn't a file upload, so `lib/import/` wasn't
  reused). `previewBulkRooms` (read-only) classifies every row OK /
  DUPLICATE_IN_BATCH / ALREADY_EXISTS, checking existing names WITHOUT a
  `deletedAt` filter since `Room.name`'s unique constraint isn't
  deletedAt-scoped (a soft-deleted room's name still collides at the DB
  level though it's invisible in the normal active list) — every row
  sharing a duplicate name is flagged, not just the 2nd+ occurrence.
  `bulkCreateRooms` creates only the client-filtered OK rows via one
  `createMany({ skipDuplicates: true })` call, re-checking existence
  immediately before writing rather than trusting the preview (a defensive
  second guard against a race, not the primary one — the pre-filter
  already excludes every known conflict), and reports "X created, Y
  skipped" without failing the whole batch on a conflict. Audited as
  `TIMETABLE_ROOMS_BULK_CREATED` with requested/created/skipped counts.
  New tests: `range-generator.test.ts` (padding-width inference, no
  double-padding when the number is naturally wider, empty-prefix/
  non-numeric/start-after-end/oversized-range rejection — including a
  regression for an early bug where `.trim()` on the prefix silently
  destroyed an intentional trailing space like `"Lab "`), `rooms/
  actions.test.ts` (permission gate, both classification statuses,
  DB-existence re-check at confirm time, in-batch de-dup, audit payload).

New feature — Campus as a top-level entity (branch `feature/timetable`):
  Rooms now belong to a required Campus. New `Campus` model (name unique,
  address nullable, soft-deleted like every other simple-CRUD entity in
  this app), migration `20260727030000_campus`. Investigated the live DB
  before writing any migration logic: found 4 pre-existing Room rows with
  no campus concept — rather than guess how to migrate them, asked the app
  owner directly whether to auto-create a default "Main Campus" and
  backfill, or require manual per-room assignment first. Confirmed:
  auto-create + backfill, so `Room.campusId` could go straight to a strict
  `NOT NULL` FK in the same migration (verified against the live DB
  afterward — all 4 rooms correctly landed under "Main Campus"). A real,
  deliberate schema consequence followed from the feature's own stated
  reasoning: Room.name's uniqueness moved from global
  (`name @unique`) to per-campus (`@@unique([campusId, name])`) — the
  entire point of labelling room pickers "Room name — Campus" is that
  identically-named rooms across campuses are an expected scenario, which
  the old global constraint would have made impossible to create at all.
  New `admin/timetable/campuses/` (schema/actions/CampusesClient) mirrors
  the Rooms CRUD pattern exactly, colocated as a third "Campuses" tab on
  the same Timetable page (not under Academic Structure — Campus only
  matters in the context of Rooms/Timetable), gated on the existing
  `timetable.manage` permission with no new key added. Room's single
  Add/Edit form gained a required Campus picker; the Bulk Add Rooms dialog
  gained a required Campus picker applied to the WHOLE batch (both paste
  and range modes, not per-row) — `previewBulkRooms`/`bulkCreateRooms`
  both took on a leading `campusId` parameter and their duplicate-scoping
  queries moved from a bare `name` filter to `{ campusId, name }`. Every
  room picker across the Timetable module (the Add/Edit Slot dialog's Room
  field, the Weekly Grid's Room filter, the Rooms tab's own list) now
  shows `"{room.name} — {campus.name}"`; the Weekly Grid gained a Campus
  filter alongside Class/Lecturer/Room/Semester, and selecting a campus
  there narrows the Room filter's own option list client-side (mirroring
  Assignments' class-narrows-course picker) — tried also auto-clearing a
  now-stale Room filter on campus change, reverted it: `useUrlTableState`
  builds each `setFilter` call off the same `searchParams` snapshot, so
  two sequential calls in one handler silently clobber each other; a
  mismatched filter combination just yields an empty grid instead, same
  as every other filter combo in this app. New/updated tests:
  `campuses/actions.test.ts`, `rooms/actions.test.ts` (re-scoped to assert
  `(campusId, name)` duplicate checks, plus a same-name-different-campus
  case proving uniqueness is per-campus not global), `queries.test.ts`
  (campus fetched unscoped like rooms, the new campusId slot filter).

Extension — FT/PT valid days + whole-week timetable builder (branch
  `feature/timetable`): three deltas on top of the already-shipped Class
  Timetable/Campus work.
  1. **FT/PT valid teaching days**: FT classes may only be scheduled
     Saturday-Wednesday, PT classes only Thursday-Friday
     (`lib/timetable-days.ts`). `DayOfWeek` gained `SUN` (migration
     `20260727040000_dayofweek_sunday` — the enum had no Sunday at all
     before this). Investigated the live DB before writing the migration:
     zero existing `TimetableSlot` rows, so there was no legacy data that
     could violate the new rule — nothing to report/migrate there.
     Enforced server-side on every slot-writing path
     (create/update/build-week) and reflected client-side in the Add/Edit
     Slot dialog's Day dropdown, which only offers the valid days for the
     selected assignment's class and clears an now-invalid picked day on
     assignment change. A class with no `studyMode` set is unrestricted
     (nullable field, matches this app's existing nullable-batch-field
     fallback pattern elsewhere).
  2. **campus.manage / room.manage split from timetable.manage**: two new
     ADMIN-only permission keys (migration
     `20260727050000_campus_room_permissions`) replace the
     `timetable.manage` check that used to gate Campus/Room CRUD — DEAN
     keeps `timetable.manage` (scoped scheduling) but loses implicit
     campus/room management, matching a direct re-reading of the
     originating request ("ADMIN manages... all campuses/rooms. DEAN
     manages only classes in their faculty"). `TimetablePanel` now also
     resolves `canManageCampuses`/`canManageRooms` from the session and
     passes them to `RoomsClient`/`CampusesClient`, which hide (not just
     disable) their Add/Bulk-add/Edit/Deactivate controls when false —
     the Rooms/Campuses tabs stay visible and browsable to a DEAN,
     read-only.
  3. **"Build timetable" whole-week builder** — the actual main ask:
     builds an entire class's week in one submit rather than one slot at
     a time (`admin/timetable/build-timetable-client.tsx`, now the
     default-selected tab). Picking a class narrows the offered days to
     its `studyMode`'s valid set before a single field is even shown; each
     valid day gets its own free-form list of add/remove sessions (course
     restricted to that class's real assignments for the picked semester,
     free start/end time, room labelled "Room — Campus"). The new
     `buildClassTimetable` action deliberately returns a structured
     `{ok, violations: {sessionKey, message}[]}` result instead of
     throwing one joined string like the single-slot actions do — a
     multi-row submission needs its problems attributed to the specific
     row that caused them. Validates day-validity, that every assignment
     genuinely belongs to the chosen class+semester, then a new
     `findWeekBuilderConflicts` (`lib/timetable-conflicts.ts`) that checks
     each session against BOTH existing DB slots for that semester AND
     every other session in the same submitted batch — the reason a whole
     -week endpoint needs its own conflict function at all, since two
     brand-new sessions can conflict with each other before either is
     persisted. Strictly all-or-nothing: any violation anywhere blocks
     every create, the UI never clears entered data on failure (only on
     genuine success) and shows each row's own violations inline beneath
     it. Success creates every session via one `createMany` and audits
     ONE `TIMETABLE_WEEK_BUILT` summary entry, matching the existing
     BULK_ASSIGNED/BULK_IMPORT one-entry-per-batch convention rather than
     one per session. The pre-existing single-slot Add/Edit/Delete flow on
     the Weekly Grid tab is unchanged and remains how mid-semester
     one-off adjustments are made after a week is already built.
  New/updated tests: `lib/timetable-days.test.ts` (FT/PT day sets, null-
  studyMode fallback), `lib/timetable-conflicts.test.ts` (new
  `findWeekBuilderConflicts` cases — in-batch conflicts, against-DB
  conflicts, different-day never conflicts), `admin/timetable/
  actions.test.ts` (day-rejection on create/update, the full
  `buildClassTimetable` suite — permission gate, dean class-scoping,
  clean-week success, day violations, out-of-scope-assignment violations,
  in-batch conflicts, against-DB conflicts, audit payload) — the existing
  `assignment` mock and its `findFirst` call-shape assertions were updated
  throughout for the new `class: { studyMode }` include this phase added
  to `resolveScopedAssignment`.

Bug fix — bulk account-generation transaction timeout (branch
  `fix/bulk-import-transaction-timeout`): a real production error report
  (`confirmLecturerImport` throwing "Transaction already closed... 5368ms
  passed" while importing 5 lecturers) traced to `argon2.hash` being
  called once per row INSIDE the `prisma.$transaction(...)` callback in
  both `admin/users/bulk-import-actions.ts`'s `confirmLecturerImport` and
  `admin/student-accounts/actions.ts`'s `generateAccountsForClass` —
  argon2id is deliberately slow, so hashing several rows' passwords
  serially inside one interactive transaction reliably blows past
  Prisma's ~5s default timeout. Fixed both by hashing every row's
  password (concurrently, via `Promise.all`) BEFORE opening the
  transaction, so the transaction itself only does fast DB writes; see
  the new Business Rules bullet on this pattern. Caught and fixed a
  second bug during this same fix's own review before it shipped: an
  early version of the `generateAccountsForClass` fix accidentally
  generated a SECOND random password to hash, separate from the one
  returned/shown to the admin — silently breaking that student's login.
  New regression tests in both actions' test files assert hashing
  happens before `$transaction` is ever called (via mock
  `invocationCallOrder`) and that each row's returned temp password is
  genuinely distinct per row.

Follow-up fix — the hash-outside-transaction change alone didn't fully
  resolve the failure in real testing (reported as "Transaction not
  found" / a stale-transaction error, a different symptom than the
  original timeout-with-elapsed-time message) — consistent with the
  second suspected cause: Neon's pooled `DATABASE_URL` connection
  (pgbouncer-style transaction pooling) being less tolerant of
  longer-lived interactive transactions than a direct connection,
  independent of hashing. Added `BULK_TRANSACTION_OPTIONS` (`lib/db.ts`:
  `{ timeout: 30000, maxWait: 10000 }`) as an explicit safety margin over
  Prisma's defaults (5s/2s), and audited every `prisma.$transaction(async
  (tx) => ...)` call site in the codebase for the same
  loops-over-a-variable-sized-batch risk profile — not just the two
  argon2 ones. Found and fixed three more genuine cases that had no
  password hashing at all but loop over rows with a per-row auto-enroll
  fan-out (each iteration issuing several more DB round trips):
  `admin/students/bulk-import-actions.ts`'s `confirmStudentImport`,
  `admin/semesters/actions.ts`'s `openSemester` (potentially the largest
  — every advancing class × every new assignment's full-class
  auto-enroll), and `admin/assignments/actions.ts`'s
  `bulkCreateAssignments`. Left every single-row/bounded transaction
  alone (single user/student/assignment creation, role/permission CRUD,
  enrollment transfer, ownership transfer) — confirmed via a full-codebase
  audit these never loop over an unbounded batch, so they don't carry
  the same risk and don't need the option. Deliberately did NOT touch
  `DATABASE_URL`/`DIRECT_URL` per the explicit instruction that came with
  this request — the explicit timeout is the primary fix, with routing
  a specific transaction-heavy path through `DIRECT_URL` (or restructuring
  it away from an interactive transaction) documented as the next
  escalation step if this still isn't enough on a real large batch. New
  regression tests (one per fixed call site, five total) assert
  `prisma.$transaction` is invoked with `BULK_TRANSACTION_OPTIONS` as its
  second argument.

New feature — Shift templates for timetable time entry (branch
  `feature/timetable`): a `Shift` model (name, studyMode [FT|PT],
  startTime, endTime, deletedAt — migration `20260727060000_shifts`) is a
  reusable time-of-day preset scoped to a studyMode, purely a data-entry
  convenience. Deliberately has NO relation to `TimetableSlot` — picking
  one just copies its start/end time into the already-editable time
  fields on whichever form is open, so conflict detection needed zero
  changes (it only ever sees the resulting plain time, same as a
  hand-typed one). A third ADMIN-only permission, `shift.manage`
  (migration `20260727070000_shift_permission`), was added alongside
  `campus.manage`/`room.manage` for the same reasoning (centrally
  administered, not a per-faculty concern) — reading/picking a shift
  needs no permission beyond the existing `timetable.manage`, only
  creating/editing/deactivating one does, mirroring the campus/room
  read-vs-manage split exactly (`canManageShifts` hides, never disables,
  the Shifts tab's Add/Edit/Deactivate controls for a DEAN). New
  `admin/timetable/shifts/` (schema/actions/`ShiftsClient`) mirrors the
  Rooms/Campuses CRUD pattern as a fourth tab on the Timetable page.
  Wired into both places a session's time gets entered: the single-slot
  Add/Edit dialog's shift picker filters to the SELECTED ASSIGNMENT's
  class's studyMode (recomputed live as the assignment changes, same
  idiom as the Day picker's narrowing); the Build Timetable week
  builder's picker filters to the ONE selected class's studyMode, shared
  by every session row since a week-builder session always belongs to
  that same class. Both pickers are stateless "apply" triggers (always
  reset to a placeholder after firing, no bound "currently selected
  shift" value) rather than a synced value, so there's no stale-selection
  UI to reconcile if the admin edits the time away from what a shift
  filled in. New tests: `shifts/actions.test.ts` (permission gate, CRUD,
  end-after-start validation), `queries.test.ts` (shifts fetched
  unscoped like campuses/rooms), `lib/permissions.test.ts` (all three
  infrastructure keys — campus/room/shift.manage — pinned ADMIN-only in
  one consolidated test).

Business rule change — One room per class in the week builder (branch
  `feature/timetable`): a class typically uses ONE room for its entire
  week, not a different room per session, so the "Build Timetable" week
  builder's Room field moved from per-session to a single class-wide
  picker at the top of the form (alongside Class/Semester), selected once
  per build. No schema or action change was needed for this — both
  `buildTimetableSessionSchema` and `buildClassTimetable` already carried
  `roomId` per session (needed for the pre-existing exception case, see
  below), so this was purely a client-side (`build-timetable-client.tsx`)
  reshaping of how that same per-session value gets populated: every
  session's effective room is `row.roomOverride ? row.roomId :
  mainRoomId`, computed at submit time, so changing the top-level room
  picker automatically re-applies to every non-overridden session with no
  extra sync code needed. Conflict detection
  (`findWeekBuilderConflicts`/`findTimetableConflicts` in
  `lib/timetable-conflicts.ts`) is completely unchanged — it already only
  ever looks at each session's resulting `roomId`, never caring whether
  that came from the class's main room or an override, so it still
  correctly flags a double-booking against ANY other class's slots in
  that room. A "Different room for this session" checkbox on each
  individual session row (default off) is the deliberately secondary
  escape hatch for real exceptions (e.g. one course needing a lab
  instead of the classroom) — checking it seeds that row's room with the
  class's main room (still freely editable from there) instead of
  leaving it blank; unchecking it clears the row back to silently
  following the main room, so there's no stale per-row room value left
  behind if the toggle is flipped back off. The single-slot Add/Edit
  dialog (`timetable-client.tsx`, for later mid-semester adjustments) got
  a smaller version of the same norm rather than a top-level picker of
  its own, since it only ever handles one session at a time: picking a
  course assignment now prefills the Room field with whichever room is
  already used by MOST of that class's other existing sessions (a
  frequency count over the already-loaded `slots` list, scoped to the
  selected assignment's `classId`) — but only while the field is still
  empty, so it never overwrites a room already chosen, including one
  already set when editing an existing slot. The field stays fully
  editable either way; this is a convenience default, never a lock,
  matching how the Shift picker already behaves for start/end time.

Business rule change — Campus & Room management moved to its own section
  (branch `feature/timetable`): Campus/Room CRUD is no longer embedded in
  the Timetable page — it now has its own standalone hub,
  `/admin/campuses` (tabs Campuses | Rooms, `admin/campuses/page.tsx`
  using the same `HubTabs` pattern as `/admin/structure`/`/admin/students`
  — `/admin/campuses` reuses its own path for the "Campuses" tab exactly
  like `/admin/students` does for "Students"). Motivation: `campus.manage`
  /`room.manage` are already independent ADMIN-only permission keys (see
  the "Campus/Room permissions split from timetable.manage" bullet above)
  — a user granted only one of them had no way to reach the controls those
  keys unlock without ALSO holding `timetable.manage`/`timetable.view`,
  since Rooms/Campuses were tabs buried inside the Timetable page. This
  was purely a relocation, not a rewrite: `admin/timetable/campuses/`
  (`actions.ts`, `schema.ts`, `campuses-client.tsx`) moved file-for-file to
  `admin/campuses/` (now also the hub's own `page.tsx` + a new
  `panel.tsx` fetching the campus list and resolving `canManage` from
  `campus.manage`), and `admin/timetable/rooms/` (`actions.ts`,
  `schema.ts`, `rooms-client.tsx`, `bulk-add-rooms-dialog.tsx`,
  `range-generator.ts` + its test) moved file-for-file to `admin/rooms/`
  (a sibling top-level dir, same "hub page + sibling sub-resource dirs"
  shape as Students/Student Accounts/Enrollments/Transfer Students;
  `admin/rooms/page.tsx` is a thin redirect to `/admin/campuses?tab=rooms`,
  same convention as every other sub-resource's standalone route).
  Zero logic changes inside the moved `actions.ts`/`schema.ts`/client
  files beyond `revalidatePath` gaining `/admin/campuses` alongside the
  pre-existing `/admin/timetable`/`/dean/timetable` (kept because those
  pages still read the same `Room`/`Campus` tables as reference data, see
  below). `TimetableClient` (`admin/timetable/timetable-client.tsx`) lost
  its "Rooms"/"Campuses" `TabsTrigger`/`TabsContent` pairs and the
  `canManageCampuses`/`canManageRooms` props it used to thread down to
  them — the Shifts tab and `canManageShifts` are untouched, since Shifts
  were never part of this move. `getTimetablePanelData`
  (`admin/timetable/queries.ts`) is completely unchanged: it still fetches
  `rooms`/`campuses` via `getRoomOptions`/`getCampusOptions` because the
  Weekly Grid's Campus/Room filters and the Add/Edit Slot dialog's Room
  picker still need them — Timetable now only READS this data, it no
  longer manages it. Old in-page links (`/admin/timetable?tab=rooms` /
  `?tab=campuses`, and the Dean read-only equivalents) are forwarded by a
  small redirect added to `admin/timetable/page.tsx` (to
  `/admin/campuses?tab=…`) and `dean/timetable/page.tsx` (back to plain
  `/dean/timetable`, since a Dean can't reach the ADMIN-only
  `/admin/campuses` at all — `AdminLayout`'s `ADMIN_SECTION_PERMISSIONS`
  already listed `campus.manage`/`room.manage` even before this move, so
  no layout change was needed there). `nav-items.ts` gained one new ADMIN
  -section link, "Campuses" (`/admin/campuses`, `Landmark` icon,
  `permissions: ["campus.manage", "room.manage"]` — any-of, so either key
  alone is enough to see the link, independent of `timetable.view`).

New feature — Timetable "Now" quick-filter view (branch `feature/timetable`,
  ADMIN + DEAN only — Lecturer/Student keep their existing simple read-only
  Weekly Grid page, unchanged): a new "Now" tab on `/admin/timetable` and
  `/dean/timetable` (added alongside Build Timetable/Weekly Grid/Shifts;
  Build Timetable stays the default-selected tab, unchanged) shows what's
  currently in progress and what's next, with a quick-select
  (Now/Morning shift/Afternoon shift/Full week) plus Class/Lecturer/Room/
  Campus/Day filters, and an Export Excel button.
  - **Pure logic in `lib/timetable-now.ts`** (DB-free, unit-tested, same
    spirit as `lib/timetable-conflicts.ts`/`lib/timetable-days.ts`):
    `getCurrentDayAndTime` reads the SERVER's own local clock (this app
    has no per-user/institution timezone setting anywhere else — same
    simplicity as everywhere `startTime`/`endTime` plain "HH:MM" strings
    are already handled). `classifyForNow(candidates, now)` splits
    today's matching slots into `inProgress` (half-open
    `start <= now < end`) and `next` (later today, soonest first); if
    today has neither, it walks FORWARD up to 7 days to the nearest day
    with any candidate at all — `TimetableSlot` has no real date, only a
    recurring day-of-week, so wrapping all the way to "next {today's own
    weekday}" (offset 7) for a class that only ever meets on that one day
    is the correct nearest occurrence, not a backward reach; a closer day
    within the week always wins over that wrap. `shiftsForPeriod(shifts,
    period)` splits Shift records into morning (`startTime < 12:00`) /
    afternoon (`>= 12:00`) purely by clock time, since Shift has no
    explicit AM/PM tag and the quick button isn't scoped to one class's
    studyMode. `matchesAnyShiftRange(startTime, ranges)` checks a
    session's start against EACH matching shift's own `[start, end)`
    range individually — deliberately NOT one collapsed min-to-max span,
    so a gap between two non-contiguous shifts (e.g. 08:00-10:00 and
    10:30-12:00) is never wrongly counted as "morning." `ALL_DAYS_ORDER`
    (the Sat-first fallback day list) moved from a local const in
    `weekly-grid.tsx` into `lib/timetable-days.ts` as a shared export,
    deduplicating the two copies.
  - **Server-side resolution, not client-side hiding — but no extra DB
    round trip either**: `admin/timetable/panel.tsx`'s `resolveNowView`
    runs the classification ENTIRELY server-side, in-memory, against the
    SAME already-fetched `slots` list `getTimetablePanelData` already
    scoped through dean_departments + the Class/Lecturer/Room/Campus/
    Semester filters — the day/quick narrowing itself never touches
    Prisma again, and the client never receives unfiltered data to hide
    client-side. This deliberately does NOT push a `dayOfWeek` filter
    into `buildTimetableWhere`/`TimetableFilters` (both untouched) — doing
    it in-memory in the Server Component instead is what keeps the new
    `quick`/`dayOfWeek` search params from silently affecting the
    pre-existing Weekly Grid tab, which reads the exact same `slots` prop
    but never looks at those two params.
  - **Reused, not duplicated, scope/semester resolution**:
    `admin/timetable/queries.ts` gained `resolveTimetableScope` (the
    isDean/departmentIds/scope/assignmentWhere/classWhere branch, extracted
    out of `getTimetablePanelData` as a behavior-preserving refactor — the
    same `queries.test.ts` assertions on Prisma call shapes all still
    pass unchanged) and `resolveEffectiveSemesterId` (the
    `ALL_SEMESTERS_VALUE`/active-semester-default logic). Both are shared
    with the new `getSlotsForExport(userId, filters)`, used by
    `exportTimetable` — this is what guarantees the export can never
    disagree with the panel about what a given Dean/filter combination
    means.
  - **Export Excel** (`exportTimetable` in `admin/timetable/actions.ts`,
    gated on `timetable.view` — a read action, same permission the page
    itself already requires): re-resolves the exact quick mode + filters
    passed from the client (mirroring `resolveNowView`'s logic
    server-side again, this time via `getSlotsForExport` +
    `classifyForNow`/`shiftsForPeriod`/`matchesAnyShiftRange`) and builds
    an xlsx (Day/Start/End/Status/Course/Class/Lecturer/Room/Campus/
    Semester columns) via the same `xlsx` + base64 +
    `lib/download.ts`'s `downloadBase64` pattern Dean/Lecturer Reports
    already use. A snapshot at generation time, not a live document — it
    doesn't auto-refresh, matching the explicit spec this feature was
    built against. **Export PDF was deliberately NOT built in this
    pass** — this project had zero PDF-rendering dependency before this
    feature (only `xlsx` existed) and adding one (jsPDF, a headless-
    browser renderer, etc.) was explicitly deferred as its own decision
    rather than rushed in alongside everything else here; the Export
    Excel button ships alone for now.
  - **UI** (`admin/timetable/now-view-client.tsx`): a quick-select pill
    row (Now/Morning shift/Afternoon shift/Full week, `primary`-accented
    when selected — not the design mockup's navy/black, kept consistent
    with this app's existing indigo `primary` token used everywhere
    else) drives a `quick` URL param via the same `useUrlTableState`
    idiom as every other filter in this app. The Day `Select` is only
    enabled when `quick === "full"` (Now/Morning/Afternoon always mean
    TODAY, resolved server-side — a visible-but-disabled Day picker
    showing "Today" makes that explicit rather than just hiding the
    control). Class/Lecturer/Room/Campus filters are the SAME URL params
    the Weekly Grid tab already uses (shared/global, not per-tab) — no
    Semester picker was added to this view specifically; it silently
    follows the Weekly Grid tab's existing Semester filter (defaulting to
    the active semester), since the spec never asked for a Now-view-
    specific semester control. Session cards reuse the WeeklyGrid
    restyle's visual language (colored left-accent bar, room shown as a
    labelled `"{room.name} — {room.campus.name}"`, lecturer with a
    `User` icon) with one deliberate addition: a green left-accent bar +
    `NOW` badge specifically for in-progress sessions (green already
    being this app's established "active/published" semantic color),
    versus the usual `primary`-indigo bar + `NEXT` badge (or no badge at
    all under Morning/Afternoon/Full week, where "next" isn't a
    meaningful distinction) for everything else. The 3-dot Edit/Delete
    menu reuses the EXACT SAME `openEdit`/`onDeleteSlot` handlers (and
    therefore the exact same Add/Edit dialog) the Weekly Grid tab already
    has — no second edit flow was built. **Fields shown are exactly the
    real schema columns** (course, class, lecturer, room, campus,
    day/time) — the design mockups this feature was built from also
    showed a session "type" (Lecture/Seminar/Lab), a room "floor," a
    class "section" code, a free-text "topic" note, and a mobile "lunch
    interval" block; NONE of these exist anywhere in `TimetableSlot`/
    `Course`/`Room`'s actual columns (verified against schema.prisma
    before writing any UI), so none of them were fabricated into the
    display — matching this app's standing "render the data as it
    actually is" instruction. The design mockups' bottom-tab-bar mobile
    app shell was similarly NOT adopted — this app's real navigation
    shell (sidebar + top bar, per the UI & Design section above) was left
    untouched; only this tab's own content is responsive.
  - New tests: `lib/timetable-now.test.ts` (day/time mapping, in-progress/
    next classification, the forward-fallback including the "wraps to next
    week, never reaches backward" case, morning/afternoon shift-window
    splitting and the non-contiguous-gap case), `admin/timetable/
    queries.test.ts` gained `getSlotsForExport` coverage (ADMIN unscoped,
    DEAN scoped identically to the panel query, unassigned DEAN empty,
    semester defaulting/`"all"`), `admin/timetable/actions.test.ts` gained
    `exportTimetable` coverage (permission gate, all four quick modes
    producing the right rows via a real `XLSX.read` round-trip on the
    returned base64 rather than mocking `xlsx` itself, empty-result and
    unassigned-Dean header-only-sheet cases).
  - **Not visually verified end-to-end in a browser** — `now-view-
    client.tsx` depends on `next/navigation`'s router hooks
    (`useUrlTableState`), which need a real authenticated Next.js request
    to render; every route in this app is gated by `proxy.ts` except
    `/login`, and (same constraint hit during the earlier student-results-
    redesign phase) there was no test account available to log in with
    from this environment. The pure `SessionCard` visual (colors/badges/
    layout, no navigation hooks) WAS checked via a static render +
    screenshot and matches the WeeklyGrid restyle's visual language. The
    interactive shell — filters, quick-select pills, the Export button,
    URL state — needs a manual check in a real logged-in session before
    this is considered done.

Extension — Timetable "Now" view's quick-select is dynamic, generated
  from Shift records (branch `feature/timetable`): the fixed "Morning
  shift"/"Afternoon shift" buttons (a noon-split heuristic over Shift
  records, `lib/timetable-now.ts`'s old `shiftsForPeriod`) are replaced by
  one button per active Shift, labelled with that Shift's own `name` and a
  small time-range subtitle (e.g. "08:00–12:00") — `shiftsForPeriod` and
  its `ShiftPeriod` type were removed outright (dead code once nothing
  called them) rather than left alongside the new behavior.
  - **URL/state model**: `quick` (the same URL param as before) is now
    either `"now"`, `"full"`, or a Shift id — there's no fixed enum to
    validate a dynamic value against, so `panel.tsx`'s `resolveNowView`
    just looks the value up against the fetched `shifts` list; anything
    that isn't `"now"` and isn't a real (currently-active) Shift id
    — including a stale id from a since-deactivated Shift — falls back to
    `"full"`, the same graceful-fallback spirit `dayOfWeek`/other filters
    already use elsewhere in this app. `NowViewData` gained `activeShift`
    (the resolved Shift record, non-null only when `quick` matched one) so
    the header line can show `"{Day} · {Shift name} ({start}–{end})"`
    instead of the plain current-time line. `exportTimetable`
    (`admin/timetable/actions.ts`) mirrors this exactly — same lookup
    against `getShiftOptions()`, same fallback-to-full behavior — so the
    export can never disagree with what's on screen; its `TimetableExportParams.quick`
    schema field changed from a fixed `z.enum([...])` to `z.string().min(1)`
    for the same reason. The exported filename uses the Shift's own
    (sanitized) `name` instead of the id (`Timetable_Morning_Shift_
    2026-07-29.xlsx`, not `Timetable_ckabc123xyz_...`).
  - **Relevance filtering is a UI-only concern** (`now-view-client.tsx`),
    not a data-security one — clicking a shift button's session-matching
    logic (today + that Shift's time window) doesn't care whether the
    Shift "belongs" to the currently-filtered class, so this needed no
    server-side change: when the Class filter is active, the buttons shown
    narrow to that class's own `studyMode`'s Shifts only (a class with no
    `studyMode` set yet — nullable, legacy data — imposes no restriction,
    same fallback this app already uses everywhere else `studyMode` gates
    something); with no Class filter, every active Shift is offered,
    visually grouped under small "FT"/"PT" labels within the same pill row
    so it's clear which is which, rather than one undifferentiated list.
  - **Empty state**: when zero active Shifts exist at all (not just zero
    matching the current studyMode), a dashed-border prompt appears below
    the quick-select row ("No shift templates have been created yet — add
    one to get quick shift-based filters here.") with a "Go to Shifts"
    link. That link jumps to the Shifts tab ON THE SAME PAGE — the
    Timetable page's internal Tabs (Build/Grid/Now/Shifts) were converted
    from an uncontrolled `defaultValue="build"` to a controlled
    `value`/`onValueChange` pair (`timetable-client.tsx`'s own
    `activeTab` state, still defaulting to `"build"` — unchanged from
    before) specifically so `NowViewClient` could be handed an
    `onGoToShifts` callback that switches tabs programmatically; this
    Tabs instance still deliberately does NOT become URL-driven (no `tab=`
    query param) — that would be a larger, unrelated change to the
    established "this page's internal Tabs are local state, unlike the
    hub pages' `HubTabs`" convention documented above.
  - Updated tests: `lib/timetable-now.test.ts` lost the `shiftsForPeriod`
    describe block (dead code); `admin/timetable/actions.test.ts`'s
    `exportTimetable` suite replaced its 'morning'/'afternoon' cases with
    a real-Shift-id case, an "other shift" case (proving it's scoped to
    exactly the ONE picked Shift, not both), and an unrecognized-quick-
    value-falls-back-to-full-week case.
  - Not re-verified end-to-end in a browser for the same
    `next/navigation`-requires-a-real-authenticated-request reason as the
    original "Now" view — the new `ShiftButton` pill's pure visual styling
    (two-line name/time-range button, selected state, FT/PT grouping
    labels, the empty-state prompt) WAS checked via a static render +
    screenshot.

Fix — Timetable is ONE unified view, not tabs (branch `feature/timetable`):
  the separate "Weekly Grid" and "Now" tabs on `/admin/timetable` and
  `/dean/timetable` are gone — there is exactly one schedule view now,
  and "Now" (today, live, in-progress/next split) is simply its DEFAULT
  filter state on first load, not a distinct screen. The Timetable page's
  internal Tabs went from four (Build Timetable | Weekly Grid | Now |
  Shifts) to three: **Timetable** (the unified view — new default, tab
  value `"now"`), **Build Timetable**, **Shifts**. `activeTab`'s default
  changed from `"build"` to `"now"` for exactly this reason — landing on
  the page shows the live schedule immediately, no tab click needed.
  `components/timetable/weekly-grid.tsx` (the time-row/day-column grid
  component) was NOT touched or deleted — it's simply no longer rendered
  by admin/dean, only by Lecturer/Student's own unchanged read-only pages
  (see the "UI" bullet in the main Class Timetable business-rules entry
  above, updated to point here instead of re-describing a UI that no
  longer exists).
  - **Day is now a first-class, always-enabled filter dimension**, not a
    control gated behind picking "Full week" first. Previously the Day
    `Select` was `disabled` unless `quick === "full"`; now it's always
    interactive, and `resolveNowView` (`admin/timetable/panel.tsx`) treats
    an explicit `dayOfWeek` as always winning over "now"'s live/today-only
    semantics — picking a day shows that ENTIRE day's sessions in time
    order, no NOW/NEXT split, exactly like "Full week + that day" already
    did before this fix (that combination already existed; what's new is
    reaching it directly without the "Full week" detour). A picked Shift
    still composes on top: it now resolves against whichever day is in
    effect (the explicit Day filter, or today if none is set) rather than
    always hard-coding "today" — the one genuinely new piece of matching
    logic, mirrored identically in `exportTimetable`
    (`admin/timetable/actions.ts`) so export can't disagree with the
    screen. `getSlotsForExport`'s own scope/semester resolution was
    untouched by any of this — only the in-memory quick/day
    classification layered on top of its result changed.
  - **Reconciling "Now" with an explicit Day pick** needed one interaction
    rule, implemented client-side (`now-view-client.tsx`) rather than
    silently letting two selections fight: clicking "Now" always clears
    any Day filter (`selectNow`); picking a Day while "Now" is active
    flips `quick` to `"full"` in the SAME navigation (`selectDay`) — both
    via a NEW `setFilters(updates: Record<string,string>)` method added to
    `lib/use-url-table-state.ts` (`applyParams` was already capable of
    atomic multi-key updates internally; only `setFilter`, the single-key
    wrapper, was previously exposed). This is NOT cosmetic — two
    sequential `setFilter` calls in the same handler both build their
    `URLSearchParams` off the same pre-navigation snapshot, so the first
    update gets silently clobbered by the second (the exact bug already
    hit once before and reverted, in the Weekly Grid's old campus-narrows
    -room-filter attempt — see the Campus roadmap entry). A Shift button
    click does NOT clear the Day filter (it's meant to compose with it);
    "Full week" doesn't touch it either (unchanged pre-existing behavior).
  - **The Semester filter moved into the unified view** — it used to live
    ONLY inside the (now-deleted) Weekly Grid tab's own filter bar; since
    that tab is gone, `now-view-client.tsx` gained its own Semester
    `SearchableSelect` (same `ALL_SEMESTERS_VALUE`/active-default pattern,
    reusing the `semesters` prop `TimetablePanelData` already provided) so
    the control isn't lost. The Weekly Grid tab's campus-narrows-room-
    options behavior was carried over too (`roomsForFilter` in
    `now-view-client.tsx`), same reasoning as before — a large university
    can have identically-named rooms at different campuses.
  - `headerLabel` (the small status line above the session list) now
    distinguishes three cases instead of two: fallback-day, an active
    Shift (day + shift name + time range), "now" specifically (day +
    current time), and — the new case — a plain day pick with no shift
    (just the day name, no time, since a full-day list isn't "live" the
    way "now" is).
  - New tests: `admin/timetable/actions.test.ts` gained two
    `exportTimetable` cases (`"now"` + an explicit `dayOfWeek` falls back
    to the day-filtered list, not the in-progress/next split; a Shift id
    + an explicit `dayOfWeek` matches THAT day's window, not today's) —
    both mirror `resolveNowView`'s own logic, which itself has no separate
    unit test file (display-composition logic in a Server Component, same
    "only the underlying pure `lib/timetable-now.ts` functions are
    directly tested" precedent as before this fix). All pre-existing
    tests were re-run and needed no changes — the underlying
    `classifyForNow`/`matchesAnyShiftRange` pure functions are unchanged
    by this fix, only how `panel.tsx`/`actions.ts` combine them is.
  - Not re-verified end-to-end in a browser for the same
    `next/navigation`-requires-a-real-authenticated-request reason noted
    on the original "Now" view and its shift-button follow-up.

Post-Phase-7 addition — WhatsApp Notifications (branch
  `feature/whatsapp-notify`): best-effort, unofficial, entirely optional —
  see the dedicated "WhatsApp Notifications" section above for the full
  design/disclaimer; this entry is the changelog. Migration
  `20260729145607_whatsapp_notify` adds `Student.phoneNumber`/
  `Lecturer.phoneNumber` (nullable), `whatsapp_notification_logs`
  (outbox + delivery log, `WhatsAppEventType`/`WhatsAppNotificationStatus`
  enums), `whatsapp_settings` (single `id = "singleton"` row, seeded
  disabled/DISCONNECTED), and seeds `whatsapp.manage` granted to ADMIN
  only.
  - `lib/whatsapp-notify.ts`: `notifyResultsPublished`/
    `notifyLeaveNotice`/`notifyTimetableChange`, each fully
    try/catch-wrapped so they never throw — hooked into
    `publishAssessment`, `createDailyLogEntry` (LEAVE_NOTICE only), and
    all four timetable-slot mutations (`createTimetableSlot`/
    `updateTimetableSlot`/`deleteTimetableSlot`/`buildClassTimetable`)
    with zero changes to those actions' own success/failure behavior.
  - `whatsapp-service/`: standalone Node.js package (own
    `package.json`/deps — Baileys, plain `pg`, pino, qrcode-terminal),
    meant to run on a VPS via pm2 or systemd (see its `README.md`).
    Persists the WhatsApp Web session to disk (`SESSION_DIR`, default
    `./auth_session`, gitignored — equivalent to a live login) so a
    restart never needs the QR code re-scanned unless the session is
    genuinely logged out. Polls `whatsapp_notification_logs` for
    `PENDING` rows every `POLL_INTERVAL_MS` (default 5s, small batches,
    a 1.5s delay between individual sends to reduce ban-risk from
    burst-like sending), sends via `sock.sendMessage`, writes back
    `SENT`/`FAILED`. Writes a heartbeat + live `connectionStatus` into
    `whatsapp_settings` every `HEARTBEAT_INTERVAL_MS` (default 30s).
    Excluded from the root ESLint run (`whatsapp-service/**` in
    `eslint.config.mjs`) — it's plain Node, not part of this Next.js/
    React app, and the React-hooks rule false-positived on
    `useMultiFileAuthState` (a Baileys function, not a React hook) before
    this was added.
  - `/admin/whatsapp` (own `panel.tsx`/`actions.ts`/`whatsapp-client.tsx`,
    standalone nav entry like Campuses, not folded into a hub): on/off
    toggle, connection-status card with client-side staleness detection,
    paginated/filterable delivery log (status/event-type filters, search
    by recipient/phone, same table toolkit as Audit Logs — 25/page
    default), per-row Retry on FAILED rows. Gated on `whatsapp.manage`
    both at the admin-layout outer gate and again inside `panel.tsx`
    itself (there's no separate "view" key, so the specific check lives
    on the page, matching every Server Action's "check your own key"
    rule even though this one has no mutating action to enforce it via).
  - Phone number capture: student registration form gained an optional
    Phone field; since there was no general student-edit form before
    this (only create), a new minimal `updateStudentPhoneNumber` action +
    a small click-to-edit dialog on the Students table cover(s) existing
    students registered before the field existed — deliberately the ONLY
    editable field post-registration, not a general edit endpoint. The
    Lecturer create/edit form under Admin -> Users gained the same
    optional Phone field, stored on the Lecturer profile.
  - Tests: `lib/whatsapp-notify.test.ts` (enqueue logic, disabled-feature
    no-op, never-throws-on-DB-failure for all three notify functions),
    `admin/whatsapp/actions.test.ts` (permission gate, toggle, retry's
    FAILED-only guard), `admin/students/actions.test.ts` (new file —
    `updateStudentPhoneNumber` permission/validation/audit),
    `lecturer/assessments/[assessmentId]/actions.test.ts` (new file —
    `publishAssessment`'s DRAFT guard + notify hook), plus
    `notifyTimetableChange` call assertions added to the existing
    `admin/timetable/actions.test.ts` and a LEAVE_NOTICE-only assertion
    added to `admin/daily-log/actions.test.ts`. `lib/permissions.test.ts`
    gained the `whatsapp.manage`-is-ADMIN-only parity test, same pattern
    as campus/room/shift.manage.

Business rule change — Build Timetable is drag-and-drop, not a form-based
  week submission (branch `feature/whatsapp-notify`, ported from a
  separate `sams-dragdrop-test` prototype): the "Build Timetable" tab's
  entire implementation was REPLACED — the old all-or-nothing whole-week
  submit flow (`buildClassTimetable`, its structured `{ok, violations}`
  result, the `TIMETABLE_WEEK_BUILT` audit entry, `buildTimetableSchema`/
  `buildTimetableSessionSchema`) is gone. In its place: pick a class,
  semester, and the class's one main room, then drag a course chip from a
  side list onto a Shift×Day grid cell to schedule it immediately; drag a
  placed session card to a different cell to move it; drop it on a trash
  zone to unschedule it. Built with `@dnd-kit/core`/`@dnd-kit/utilities`
  (new dependencies). Each drag action is ONE real, immediate write via
  the pre-existing single-slot actions — `createTimetableSlot`/
  `updateTimetableSlot`/`deleteTimetableSlot` — not a new bulk endpoint,
  so every drop still goes through the exact same conflict check
  (`findTimetableConflicts`), day-for-studyMode validation, per-slot
  audit log (`TIMETABLE_SLOT_CREATED`/`_UPDATED`/`_DELETED`), and
  best-effort WhatsApp notify hook (`notifyTimetableChange`) that already
  existed — nothing about those three actions' authorization or side
  effects changed, they only gained a return value (the created/updated
  slot) so the grid can reconcile its optimistic UI state (a temp id ->
  real id swap on create) without a second round-trip. A conflicting drop
  reverts optimistically and flashes the target cell red with a toast
  explaining why, rather than silently failing.
  - New read action `getClassScheduleSlots(classId, semesterId)`
    (`admin/timetable/actions.ts`, gated on `timetable.view`, dean-scoped
    via the same `classDeanWhere` pre-check idiom as everywhere else in
    this module) feeds the grid the class's already-placed sessions —
    decoupled from the "Now" view's own URL-driven Class/Lecturer/Room/
    Campus filters, since the builder has its own local class/semester
    picker.
  - The grid's rows are Shift templates for the selected class's
    studyMode (reusing `Shift` exactly as already designed — a pure
    client-side time-fill convenience, still no FK from `TimetableSlot`);
    a placed slot is mapped back to its row by whichever Shift window
    contains its `startTime` (or the closest one, if a manual time edit
    moved it outside every window). Columns are the studyMode's valid
    teaching days (`lib/timetable-days.ts`, unchanged). A class with no
    studyMode, no course assignments for the picked semester, or no
    Shifts for its studyMode each get their own explanary empty state
    (the last one links to the Shifts tab via the pre-existing
    `onGoToShifts` callback pattern already used by the "Now" view).
  - One room is picked ONCE for the whole class (same "a class normally
    uses one room all week" business rule as the old week builder) and
    applied to every new drop by default; clicking a placed card's room
    label opens an inline override for that one session only (shown with
    an "override" badge) — this reuses the schema's existing per-slot
    `roomId`, no new field. A placed card's time can also be edited
    inline (blur-to-save) for ad-hoc adjustments without reopening the
    old Add/Edit dialog.
  - The pre-existing single-slot Add/Edit dialog on the Timetable tab
    (for later one-off mid-semester adjustments) is completely unchanged
    — this replacement only affects the Build Timetable tab's own
    component, `build-timetable-client.tsx`.
  - Updated tests: `admin/timetable/actions.test.ts` — the whole
    `buildClassTimetable` describe block was removed and replaced with a
    `getClassScheduleSlots` suite (permission gate, ADMIN-unscoped vs.
    DEAN-scoped-via-classDeanWhere vs. out-of-scope-throws-CLASS_NOT_FOUND,
    matching the module's established scoping-test shape); the existing
    `createTimetableSlot`/`updateTimetableSlot` suites each gained one new
    case asserting the now-returned slot, alongside their pre-existing
    WhatsApp-notify assertions (both still pass — the notify hook was
    untouched by this change, only added a return value to the
    functions).
  - Not yet visually verified end-to-end in a browser for the same
    reason as the "Now" view before it — the drag grid needs a real
    authenticated session, which this environment can't obtain (no test
    account available). `tsc --noEmit`, the full Vitest suite (472
    passing), and ESLint on the timetable module were all run clean,
    and the dev server (port 3000) compiles and serves `/admin/timetable`
    without error.

New feature — Customizable WhatsApp notification templates (branch
  `feature/whatsapp-notify`): the three notify functions' hardcoded
  message strings are now editable per event type from a "Notification
  Templates" tab on `/admin/whatsapp`, instead of being fixed in code.
  - **Schema**: `WhatsAppMessageTemplate` (id, `eventType` unique —
    reuses the existing `WhatsAppEventType` enum, one row each for
    RESULTS_PUBLISHED/LEAVE_NOTICE/TIMETABLE_CHANGE, NOT a new "one per
    trigger" enum — there are only ever these three triggers today;
    `templateText`, `updatedBy` nullable FK to User with `onDelete:
    SetNull`, `updatedAt`). Migration
    `20260730010544_whatsapp_message_templates` both creates the table
    AND seeds one default row per event type with the EXACT text each
    trigger hardcoded before this existed (verified byte-for-byte against
    the pre-change `lib/whatsapp-notify.ts`), idempotent on `event_type`
    — so applying this migration changes zero outgoing message text on
    its own. Also seeds the new `notification.templates.manage`
    permission (ADMIN-only role_permissions grant), same idempotent
    guarded-INSERT pattern as every prior permission-seed migration.
  - **Permission split**: `notification.templates.manage` is deliberately
    a SEPARATE key from `whatsapp.manage` (both ADMIN-only by default) —
    the on/off switch + delivery log is a different concern from message
    wording, same "each independent concern gets its own key" reasoning
    as campus.manage/room.manage/shift.manage. Both `admin/layout.tsx`'s
    `ADMIN_SECTION_PERMISSIONS` and the `/admin/whatsapp` panel's own
    gate accept EITHER key (a future custom role could hold just one);
    `nav-items.ts`'s "WhatsApp" link likewise lists both as an any-of.
  - **Placeholders are code, not data**: `lib/whatsapp-templates.ts` (a
    pure module with NO `prisma` import, so it's safe to import from the
    client Templates UI too) exports `WHATSAPP_TEMPLATE_PLACEHOLDERS`
    (the known `{token}` set per event type — e.g. RESULTS_PUBLISHED
    gets `studentName`/`courseName`/`assessmentTitle`/`className`/
    `semesterName`/`mark`; LEAVE_NOTICE gets `recipientName`/`title`/
    `date`/`description`; TIMETABLE_CHANGE gets `studentName`/
    `className`/`changeSummary`), `DEFAULT_WHATSAPP_TEMPLATES` (the
    seeded text — deliberately doesn't use every available placeholder,
    e.g. `{mark}`/`{className}` are offered but not in the default
    wording), `findUnknownPlaceholders` (flags any `{token}` outside that
    event type's set — a real typo like `{studnetName}`, or one valid
    only for a different event type), and `fillTemplate` (plain
    substitution; a key with no entry in the vars map is left as literal
    text). LEAVE_NOTICE's original "omit the dash when there's no
    description" behavior is reproduced WITHOUT any conditional syntax in
    the template itself — the caller pre-composes `description` as either
    `""` or `" — <text>"` before filling, so `{title} ({date}){description}`
    stays a plain, unconditional substitution.
  - **`admin/whatsapp/actions.ts`**: `updateWhatsAppTemplate(eventType,
    text)` requires `notification.templates.manage`, rejects a blank
    template and any unknown placeholder (via `findUnknownPlaceholders`)
    BEFORE writing anything, upserts the row, calls
    `invalidateWhatsAppTemplateCache()` so the edit takes effect on this
    instance immediately rather than waiting out the cache TTL, and
    audits `WHATSAPP_TEMPLATE_UPDATED` with old/new `templateText`.
    `resetWhatsAppTemplate(eventType)` does the same upsert/invalidate/
    audit (`WHATSAPP_TEMPLATE_RESET`) with `DEFAULT_WHATSAPP_TEMPLATES[
    eventType]` — always valid by construction, so it skips the
    placeholder re-check.
  - **`lib/whatsapp-notify.ts`**: each notify function now calls a new
    `getEffectiveTemplate(eventType)` instead of building a literal
    string. This is BOTH the caching layer (an in-memory
    `Map<WhatsAppEventType, string>`, 60s TTL, same shape as
    `lib/permission-cache.ts` — fetched ONCE per notify call even when
    fanning out to many recipients, e.g. every student in a class, not
    once per recipient) AND the fallback-safety boundary requirement 5
    asks for: a stored template is only trusted if it's non-blank and
    passes `findUnknownPlaceholders` with zero results; anything else
    (a missing row, an empty string, a value that became invalid after
    being edited directly in the DB) falls back to
    `DEFAULT_WHATSAPP_TEMPLATES[eventType]` rather than ever sending a
    broken/literal `{typo}` string. `notifyResultsPublished` was extended
    to select `class`/`semester` off the assignment and `mark`/
    `attendanceStatus` off each result (formatted as the raw mark, or
    "Absent"/"Exempt"/"—") so `{className}`/`{semesterName}`/`{mark}` have
    real values to fill even though the default template doesn't use
    them yet; `notifyTimetableChange` gained one extra `class.findUnique`
    lookup (run in parallel via `Promise.all` alongside the student list
    and the template fetch) to support `{className}`.
  - **Admin UI** (`admin/whatsapp/templates-client.tsx`, a new
    `TemplatesClient` rendered from a second `TabsContent` added to the
    existing `whatsapp-client.tsx`, which also gained a `Tabs` wrapper —
    "Delivery Log" is now the first tab, "Notification Templates" the
    second): one card per event type (fixed display order, not derived
    from which DB rows happen to exist) showing a "Default" badge when
    unedited, a "last edited by X on Y" line once it's been touched,
    clickable placeholder chips that append `{token}` to the textarea, a
    live preview (sample data per event type, computed client-side via
    the same pure `fillTemplate`), an inline "Unknown placeholder(s): …"
    warning that disables Save, and Save/Reset buttons. Read-only for a
    user without `notification.templates.manage` (textarea disabled,
    Save/Reset hidden entirely) rather than hiding the tab outright —
    matches Campus/Room/Shift's existing hide-the-controls-not-the-view
    split. Each card is keyed on `${eventType}:${currentTemplateText}` so
    a save/reset (which triggers `router.refresh()`) remounts it with the
    fresh server value as its new local state, rather than needing a
    manual effect-based re-sync.
  - Tests: `lib/whatsapp-templates.test.ts` (new — placeholder
    validation including the cross-event-type and de-dup cases,
    `fillTemplate` substitution including the LEAVE_NOTICE conditional-
    dash reproduction, every seeded default validates clean against its
    own event type), `admin/whatsapp/actions.test.ts` gained
    `updateWhatsAppTemplate`/`resetWhatsAppTemplate` suites (permission
    gate, empty-template rejection, unknown/cross-event-type placeholder
    rejection, trim-before-save, audit payloads), `lib/whatsapp-
    notify.test.ts` extended with template-specific cases (a custom DB
    template is used verbatim, an unknown-placeholder or blank stored
    template falls back to default) and its existing mocks/fixtures
    updated for the new `class`/`semester`/`mark` fields and the
    `whatsAppMessageTemplate`/`class.findUnique` lookups (each describe
    block now calls `invalidateWhatsAppTemplateCache()` in `beforeEach`
    so the module-level cache can't leak a stale template between
    tests), `lib/permissions.test.ts` gained the
    `notification.templates.manage`-is-ADMIN-only parity test, same
    pattern as whatsapp.manage/campus/room/shift.manage.

New feature — Workload Excel import + sequential auto-timetable generation
  (branch `feature/auto-timetable`): see the dedicated "Workload Excel
  import + auto-timetable generation" section above for the full
  design/business rules; this entry is the changelog. Two new,
  independent permission keys, `workload.import` and `timetable.generate`
  (migration `20260804000100_auto_timetable_permissions`, seeded to both
  ADMIN and DEAN — same WHAT/WHERE split as `timetable.manage`, dean scope
  applied via `assignmentDeanWhere`/`classDeanWhere`, re-derived from the
  caller's role every call, same idiom as every other dean-scoped
  feature). `LecturerCourseAssignment` gains a nullable `creditHours`
  `Decimal(4,2)` (migration `20260804000000_workload_credit_hours`,
  additive, no backfill — every pre-existing assignment simply has it
  unset and is therefore ineligible for auto-generation).
  - `lib/auto-timetable.ts` (new, pure, DB-free, unit-tested in
    `lib/auto-timetable.test.ts` — 18 cases covering shift-combo picking,
    the spacing rule and its fallback, hard-conflict never-force-place
    behavior, PT/FT day+shift scoping, and the sequential odd-number
    ordering helper): `findClosestShiftCombo` (existing-Shifts-only
    session-length picking), `generateTimetableForBatch` (the two-pass
    day-placement algorithm, reusing `findTimetableConflicts` from
    `lib/timetable-conflicts.ts` as its ONLY conflict check — no new
    conflict logic was written), `sequentialOddSemesterNumbers`.
  - `admin/workload-import/` (Step 1): `schema.ts`/`actions.ts`
    (`downloadWorkloadImportTemplate`/`previewWorkloadImport`/
    `confirmWorkloadImport`, the last creating assignments +
    auto-enrolling exactly like `createAssignment`/
    `bulkCreateAssignments`, audited as `WORKLOAD_IMPORTED`),
    `generator-data.ts` (unscoped room/shift reference data for the
    generator's setup step, same "no department affiliation in the
    schema" reasoning as Campus/Room/Shift elsewhere), `panel.tsx`/
    `page.tsx`, and `workload-import-client.tsx` (wraps the existing
    generic `BulkImportDialog` — no changes needed to that shared
    component, since ERROR/ALREADY_EXISTS already covered the new
    "lecturer conflict vs. same-lecturer no-op" distinction — with a
    custom `renderConfirmResult` for the Done/Continue success dialog).
  - `admin/auto-timetable/` (Step 2, no standalone nav entry — only ever
    reached from Step 1's own success dialog): `queries.ts`
    (`getClassMainRoomId`, the majority-of-existing-sessions heuristic
    reused as-is from the drag-and-drop Build Timetable's own room
    prefill logic), `schema.ts`, `actions.ts`
    (`previewAutoTimetableBatch` — a pure read, re-verifies every
    assignment against the DB and the caller's dean scope rather than
    trusting the client's copy of creditHours/names/studyMode;
    `confirmAutoTimetableBatch` — one transactional `createMany`,
    re-validated against fresh conflict candidates immediately before
    writing, audited as one `AUTO_TIMETABLE_GENERATED` entry per
    confirmed level, triggering the existing `notifyTimetableChange` hook
    once per affected class), and
    `auto-timetable-generator-client.tsx` (the results-screen UI: three
    sections — Scheduled normally / Scheduled with spacing fallback /
    Unscheduled — a per-class room picker, an optional per-assignment
    shift-override control, and the level-by-level Confirm-then-next-odd-
    level state machine that never offers a later level before the
    current one is confirmed).
  - `/dean/workload-import` mirrors `/admin/workload-import` by importing
    the exact same `WorkloadImportPanel` (one implementation, two routes
    — same pattern as Daily Log/Timetable); `DEAN_SECTION_PERMISSIONS` and
    `ADMIN_SECTION_PERMISSIONS` both gained the two new keys, and
    `nav-items.ts` gained one "Workload Import" link per section pointing
    at each route.
  - Zero changes to the manual "Add Assignment"/"Bulk Assign" forms
    (`admin/assignments/`) or the drag-and-drop Build Timetable grid
    (`admin/timetable/build-timetable-client.tsx`) — both remain the
    unchanged fallback path for anything this workflow doesn't fully
    handle, per the explicit requirement that this feature never weakens
    or bypasses the one-lecturer-per-course+class+semester constraint,
    dean faculty-scoping, the permission engine, or existing WhatsApp
    triggers.
  - Tests: `lib/auto-timetable.test.ts` (18 cases, see above),
    `admin/workload-import/actions.test.ts` (15 cases — permission gates,
    every preview validation branch including the lecturer-conflict-vs-
    already-exists distinction, dean-scoped class resolution, confirm's
    race-safety re-check, dean-scope re-verification at confirm time,
    audit payload), `admin/auto-timetable/actions.test.ts` (14 cases —
    permission gates, dean scoping via `assignmentDeanWhere`, out-of-
    scope/wrong-level assignments reported not dropped, never trusting
    client-supplied creditHours, race-conflict skip at confirm time,
    audit payload, exactly-one-notification-per-class). `lib/
    permissions.test.ts`'s DEAN exact-grant-list pin updated to include
    the two new keys (ADMIN has no such exact-list pin, only
    `arrayContaining` checks, so it needed no change).
  - Not yet visually verified end-to-end in a browser — same
    `next/navigation`-requires-a-real-authenticated-request constraint
    noted on every other post-Phase-7 UI addition in this log; `tsc
    --noEmit`, ESLint, and the full Vitest suite (541 passing) were all
    run clean.

Business rule change — Room assignment moves to class registration
  (branch `feature/class-room-assignment`, built on top of
  `feature/auto-timetable`): a class's default room is now set ONCE, at
  class create/edit time (Academic Structure > Classes), instead of being
  picked every time someone builds or auto-generates its timetable. See
  the "Class Timetable" business rule's "Room is a class-registration
  property" bullet above for the current-state description; this entry is
  the migration/changelog.
  - **Schema**: `Class.roomId` (nullable FK to `Room`, `ON DELETE SET
    NULL`, migration `20260805000000_class_room`) — nullable so a class
    can exist before its room is finalized, required only at
    build/generate time (validated there, never at class create/update).
    `Room` gained the inverse `defaultForClasses Class[]` relation
    (distinct from its existing `timetableSlots` — a per-slot booking —
    since a class's default room and a specific already-placed session's
    room are different concepts that happen to often coincide).
  - **Backfill**: the same migration includes a data-only `UPDATE …
    FROM (SELECT … GROUP BY … HAVING COUNT(DISTINCT room_id) = 1)` that
    sets `Class.roomId` ONLY for classes whose existing `TimetableSlot`
    rows all already use exactly one room — the same "a class normally
    keeps one room for its whole week" fact the drag-and-drop Build
    Timetable's old per-session majority-room prefill was already relying
    on, just promoted to a real stored column instead of being
    recomputed live every time. A class with NO existing sessions, or
    with sessions spanning MORE than one room (`HAVING` excludes it), is
    deliberately left `NULL` — never guessed — for manual assignment.
    This migration could not be run against the live database from the
    development environment (no network access to the Neon instance) —
    it must be applied via `prisma migrate deploy` and its actual
    backfilled-vs-needs-manual counts confirmed directly against the real
    data before this is considered fully rolled out.
  - **Class form** (`admin/classes/`): `classSchema` gained an optional
    `roomId`; `composeClassData` (`actions.ts`) carries it straight
    through with no derivation logic (unlike batchCode) — it's a plain
    user choice, not computed. `classes-client.tsx`'s Add/Edit dialog
    gained a `SearchableSelect` Room picker (`"{room.name} — {campus.name}"`,
    same pattern as every other room picker in this app) and the Classes
    table gained a Room column (shows "Not set" when null). The dialog
    also gained deep-link support: an `editClassId` search param (threaded
    through `admin/structure/page.tsx` → `ClassesPanel` → `ClassesClient`)
    auto-opens that class's edit dialog on load, then strips the param —
    this is what lets the Timetable Builder's and the auto-timetable
    generator's "this class has no room" messages link directly into the
    right class's edit form instead of just naming it.
  - **Drag-and-drop Build Timetable** (`build-timetable-client.tsx`): the
    top-of-form `mainRoomId` `SearchableSelect` picker is GONE — the
    builder now reads `selectedClass.roomId`/`selectedClass.room` directly
    (added to `getTimetablePanelData`'s classes query via a new
    `getClassOptions` helper, `admin/timetable/queries.ts`, which
    `include`s `room: { include: { campus: true } }`). A class with a
    studyMode and course assignments but no room shows a blocking amber
    message ("This class has no room assigned — set one in Academic
    Structure > Classes first") with a link to
    `/admin/structure?tab=classes&editClassId=<id>`, in place of the grid
    — the grid section simply isn't rendered until a room exists. The
    per-session room OVERRIDE on a placed card (click to pick a different
    room for one exception) is byte-for-byte unchanged, just now compares
    against `classRoomId` instead of local picker state.
  - **Auto-timetable generator** (`admin/auto-timetable/`):
    `previewBatchSchema` lost its `classRooms` input entirely — the
    server resolves each assignment's room from its own
    `class.roomId`/`class.room` (added to `loadScopedAssignments`'s
    include). Classes with no room are collected into a new
    `classesWithoutRoom: {classId, className}[]` field on
    `PreviewBatchResult` and their assignments are excluded from
    scheduling — reported, never silently dropped, never blocking the
    OTHER classes in the same level's batch. The old majority-heuristic
    `getClassMainRoomId` (`admin/auto-timetable/queries.ts`) and its
    permission-gated wrapper `getClassMainRoomForGenerator` are deleted
    outright (dead code — superseded by the real stored column, not
    reimplemented). `CreatedAssignmentSummary` (`workload-import/
    actions.ts`) gained `classRoomId`/`classRoomLabel`, sourced from the
    workload import's own class lookup (`previewWorkloadImport`'s
    `classes` query gained a `room` include), so the generator UI knows
    upfront — before even calling Generate preview — which classes need a
    room set, without an extra round trip; `auto-timetable-generator-
    client.tsx` shows the same blocking-message-with-link pattern as Build
    Timetable, and a Room column was added to the "Assignments in this
    batch" table for visibility. `admin/workload-import/generator-data.ts`
    lost its now-unused `getRoomOptionsForGenerator` (the generator no
    longer needs a room reference list — it only reads `Class.roomId`, it
    never picks from a list).
  - Tests: `admin/classes/actions.test.ts` gained a roomId-passthrough
    case and both pre-existing exact-`data`-object assertions were
    updated to include `roomId: null`. `admin/workload-import/
    actions.test.ts` gained classRoomId/classRoomLabel coverage (carried
    through for a class with a room, null for one without).
    `admin/auto-timetable/actions.test.ts` was rewritten: the room-related
    describe block for the deleted `getClassMainRoomForGenerator` is gone,
    `previewAutoTimetableBatch`'s cases now assert the room comes from the
    assignment's `class.room`/`class.roomId` relation (never a client-
    supplied `classRooms` map) and that a class with `roomId: null` is
    reported via `classesWithoutRoom` and excluded from scheduling.
  - Not yet visually verified end-to-end in a browser (same
    `next/navigation`-requires-a-real-authenticated-request constraint as
    every other UI change in this log); `tsc --noEmit`, ESLint, and the
    full Vitest suite (542 passing) were all run clean.

Business rule change — Lecturer registration split from account creation,
  lecturer login switches to phone number (branch
  `feature/lecturer-registration`): mirrors the earlier Phase 3.1 student
  registration split exactly, applied to lecturers.
  - **Schema** (migrations `20260805010000_lecturer_registration_split`,
    `20260805020000_lecturer_full_name`): `Lecturer.userId` becomes
    nullable (a Lecturer row can exist with no login account — assignable
    to teach a course either way, since `LecturerCourseAssignment` never
    required an account); `User.email` becomes nullable (lecturer accounts
    generated via Lecturer Accounts have `email = null`, `username =`
    their phone number instead); `Lecturer.phoneNumber` (already existed
    for WhatsApp) gains a uniqueness constraint, since it now doubles as
    the login identifier — same role `Student.studentNo` plays;
    `Lecturer.fullName` (new, required, backfilled from the linked User at
    migration time for the 10 pre-existing lecturer profiles) is the
    canonical name field, independent of any User — necessary because
    `Lecturer.userId` going nullable means `lecturer.user.fullName` can no
    longer be relied on ANYWHERE, so this mirrors `Student.fullName`'s
    exact original reasoning; `Lecturer.departmentId` (new, nullable FK to
    `Department`) is a plain profile field — explicitly confirmed with the
    app owner before adding, since it's NOT a scoping mechanism
    (`dean_departments`/`lib/dean-scope.ts` is completely untouched by
    this — a lecturer's own department is unrelated to which faculties a
    DEAN oversees) — captured at registration and used to filter/batch the
    Lecturer Accounts page.
  - **Existing accounts investigated before any schema decision**: the
    live DB had 11 LECTURER-role users (10 active, 1 inactive, one with no
    Lecturer profile row at all — a pre-existing data anomaly, left
    untouched, unrelated to this feature), ALL still email-based, and
    ZERO with a `phoneNumber` set — so an immediate migration to phone
    login wasn't even possible without first collecting phone numbers.
    Asked the app owner directly rather than guessing: confirmed to leave
    all 11 existing accounts on email login PERMANENTLY — phone-based
    login applies only to accounts generated going forward via Lecturer
    Accounts. Nothing about how any existing lecturer authenticates
    changed.
  - **New "Lecturer Registration" page** (`admin/lecturers/`, hub at
    `/admin/lecturers`, tabs Lecturers | Lecturer Accounts — same
    self-referencing-tab pattern as `/admin/students`): a simple repeated-
    entry form (staff_no, full_name, phone_number — REQUIRED here, unlike
    the optional WhatsApp-only `Student.phoneNumber`, since it's this
    lecturer's future login identifier — title, department) creates ONLY
    the `Lecturer` row, no account. `registerLecturer`
    (`admin/lecturers/actions.ts`) reports which unique field conflicted
    (`STAFF_NO_TAKEN` vs `PHONE_NUMBER_TAKEN`) via the P2002 error's
    `meta.target`, since a lecturer row has two independent unique keys
    unlike a student's one. Two narrow single-field edit actions for
    fixing an already-registered lecturer (`updateLecturerPhoneNumber`,
    `updateLecturerDepartment`), same click-to-edit dialog pattern as the
    Student table's phone column.
  - **New "Lecturer Accounts" page** (`admin/lecturer-accounts/`, panel
    imported into the same hub's second tab): mirrors Student Accounts —
    a department picker (plus an "Unassigned" sentinel value for
    `departmentId: null`) drives a per-department lecturer list with
    status No phone / No account / Active / Locked, a bulk "Generate
    accounts for this department" (`generateAccountsForDepartment`, same
    hash-before-transaction + `BULK_TRANSACTION_OPTIONS` pattern as
    `generateAccountsForClass` — lecturers with no phone number are
    skipped and reported via `skippedNoPhone`, never failing the rest of
    the batch), and per-lecturer Generate account / Reset password
    (`generateAccountForLecturer` blocked by `NO_PHONE_NUMBER`/
    `ALREADY_HAS_ACCOUNT`; `resetLecturerPassword` blocked by
    `NO_ACCOUNT`). Every generated account sets `username = phoneNumber`,
    `email = null`, `fullName` copied from the Lecturer row, role
    LECTURER, temp password shown once (CSV download + print, explicitly
    labelled "logs in with phone number, not email"). Audited as
    `LECTURER_ACCOUNT_GENERATED`/`LECTURER_PASSWORD_RESET`.
  - **Lecturer bulk import moved off Users** (`admin/lecturers/
    bulk-import-actions.ts`, replacing the old lecturer path in
    `admin/users/bulk-import-actions.ts`, which is deleted): now creates
    ONLY Lecturer rows (staff_no, full_name, phone_number, department —
    department resolved by code or name, unmatched is a real ERROR not a
    silent skip), no User/account, mirroring Students import exactly —
    accounts are generated afterward from Lecturer Accounts, never by
    this import. Its preview logic is bespoke (not
    `lib/import/preview.ts`'s generic single-key `buildPreview`) since a
    lecturer row has TWO independent unique keys (staff_no, phone_number)
    that can each collide alone, same shape the old email-based lecturer
    import already needed for staff_no+email.
  - **Login form needed zero changes** — `app/login/actions.ts` already
    resolved by `username OR email` (case-insensitive), and a phone number
    never collides with the email-shaped pattern, so phone-based lecturer
    login "just worked" once `Lecturer.phoneNumber` started being used as
    `User.username`.
  - **Users page**: `createUser` now rejects role LECTURER outright
    (`INVALID_ROLE` — same as STUDENT) — the plain "Add user" form has no
    way to also create the required Lecturer profile row, and a bare
    LECTURER User with none would be a dead-end ghost account.
    `updateUser` now rejects editing ANY existing LECTURER row
    (`LECTURER_NOT_EDITED_HERE`) — the real risk this closes: a
    phone-based lecturer account has `email = null`, but this form's
    email field is required, so submitting it would silently overwrite
    that account's username with whatever email got typed, breaking their
    login. Existing LECTURER rows still list on the Users page and remain
    manageable for everything that doesn't touch email/username — Roles &
    permissions, Reset password, Deactivate/Reactivate — since none of
    those care how the account authenticates. The "Add user" role dropdown
    excludes LECTURER (`createRoleItems`); the role FILTER dropdown still
    offers it, since existing lecturer rows must stay findable. Removed
    entirely from this form: the staffNo/title/phoneNumber fields and the
    "Bulk import lecturers" button (moved to Lecturer Registration).
  - **Nav**: new standalone "Lecturers" link (`/admin/lecturers`,
    `GraduationCap` icon) alongside "Students", gated on `user.manage` —
    the SAME permission Users itself already uses for staff account
    management (no new permission key added; `user.manage`'s catalog
    description already said "...import lecturers" before this feature,
    since lecturer account management conceptually always lived under it,
    just in the wrong UI location).
  - **Every lecturer-name display across the app updated** for
    `Lecturer.userId`/`.user` going nullable — a large, mechanical ripple
    (assignments, semesters wizard, timetable — build/grid/now-view,
    daily log, workload import, auto-timetable, dean ownership transfer +
    reports, lecturer/student read-only timetable pages, WhatsApp leave-
    notice notify) all switched from reading `lecturer.user.fullName`
    to `lecturer.fullName` directly, and several lecturer PICKERS
    (Assignments, Semester wizard, Timetable filter, Daily Log "about a
    lecturer") were deliberately loosened from `where: { user: {
    deletedAt: null } }` (which silently excluded every accountless
    lecturer) to `where: { OR: [{ userId: null }, { user: { deletedAt:
    null } }] }` — an unregistered-for-login lecturer must still be
    assignable/pickable everywhere except contexts that generally require
    an active account to actually log in and do the work
    (**deliberately kept account-required**: Dean Ownership Transfer's
    "new lecturer" picker, gated additionally by a new
    `LECTURER_NO_ACCOUNT` check in `transferOwnership` — the target must
    be able to log in and immediately continue the assessment work).
  - Tests: new `admin/lecturers/actions.test.ts`,
    `admin/lecturers/bulk-import-actions.test.ts`,
    `admin/lecturer-accounts/actions.test.ts`; `admin/users/actions.test.ts`
    gained `createUser`/`updateUser` coverage (previously untested in this
    file) asserting the STUDENT/LECTURER rejection and the
    `LECTURER_NOT_EDITED_HERE` guard; every pre-existing test file with a
    `lecturer: { user: { fullName } }`-shaped fixture (assignments,
    semesters, timetable, workload-import, daily-log) was updated to the
    new flat `lecturer: { fullName }` shape. Full suite: 574 passing.
  - Not yet visually verified end-to-end in a browser — same
    `next/navigation`-requires-a-real-authenticated-request constraint
    noted on every other post-Phase-7 UI addition in this log; `tsc
    --noEmit`, ESLint, and the full Vitest suite were all run clean.

Business rule change — Simplified per-class workload Excel import (branch
  `main`): the multi-class Workload Excel import (see the "Workload Excel
  import + auto-timetable generation" business rule above) gained a
  simpler, primary alternative — pick ONE class first, then the Excel file
  only needs `course_code`/`course_name` (pre-filled from that class's own
  Course Plan) plus `lecturer`/`credit_hours` to fill in; no
  `semester`/`program`/`class` columns at all. `admin/workload-import/`
  now shows a Tabs UI: **"By Class (Recommended)"** (new, default tab —
  `class-schema.ts`, `class-actions.ts`, `class-workload-import-client.tsx`)
  and **"Bulk Import (Advanced)"** (the pre-existing multi-class flow,
  completely unchanged — `schema.ts`, `actions.ts`,
  `workload-import-client.tsx` — kept as the fallback for admins who
  prefer one file across many classes at once, per explicit instruction
  not to remove it).
  - **Class picker scoping** (`panel.tsx`'s `getWorkloadImportClasses`):
    dean-scoped (`classDeanWhere`), and further filtered to classes with a
    current semester level set AND at least one course actually planned
    at that exact level — a two-query "candidates, then filter by real
    plan rows at the class's OWN level" approach (Prisma can't express
    "coursePlans some where semesterNumber = this row's own
    currentSemesterNumber" as one relational filter), same shape as the
    Open Semester wizard's pre-existing `classesWithPlans` query. This is
    what guarantees the picker can never land on a class whose template
    would come back empty or blocked.
  - **No semester picker** — both the real academic-calendar Semester
    (defaults to whichever `Semester.isActive` is true; throws
    `NO_ACTIVE_SEMESTER` if none — same "defaults to the active semester"
    convention already used by the Assignments/Timetable/Reports pickers
    elsewhere in this app) and the course-plan level
    (`Class.currentSemesterNumber`) are resolved automatically from the
    one picked class, confirming the request's "current/target
    semesterNumber is read from that class automatically" — there was
    never a request for a separate semester control, so none was added.
  - **Template generation** (`downloadClassWorkloadTemplate`): one row per
    course in `ClassCoursePlan` at the class's current level,
    `course_code`/`course_name` pre-filled straight from the DB via a new
    `buildDataTemplateBase64` helper (`lib/import/template.ts`, generalizes
    the pre-existing `buildTemplateBase64` beyond its fixed 2-example-row
    shape to an arbitrary number of real pre-filled rows) — only
    `lecturer`/`credit_hours` are left blank. This is a structural
    guarantee, not just a validation one: since the template is generated
    exclusively from the real Course Plan and there is no free-text
    "class" column anywhere in this variant's file, a course outside that
    plan can never even appear as a row, let alone get imported.
  - **Preview** (`previewClassWorkloadImport`) re-validates anyway,
    defending against a hand-edited file: `course_code` is matched ONLY
    against courses in THIS class's plan at its current level (a code for
    a real course elsewhere in the system is exactly as invalid as an
    unknown one), lecturer matched by staff number or full name,
    `credit_hours` must be a positive number — same OK/DUPLICATE_IN_FILE/
    ALREADY_EXISTS/ERROR shape and the same
    lecturer-conflict-is-an-ERROR-never-silently-overwritten rule as the
    bulk variant, just scoped to one class+semester instead of parsed per
    row.
  - **Confirm** (`confirmClassWorkloadImport`) re-resolves the class (dean
    scope + current level) and the active semester fresh — never trusts
    anything round-tripped from the client, same defense-in-depth as every
    other confirm action in this app — assembles the full
    `WorkloadImportRow` shape from that resolved context plus each narrow
    row, and delegates to a new exported `finalizeWorkloadImport`
    (`actions.ts`) — the conflict-recheck-immediately-before-writing +
    one-transaction-create + auto-enroll + audit + summary-building tail
    that used to live only inside `confirmWorkloadImport`, extracted as a
    behavior-preserving refactor (`confirmWorkloadImport` itself is
    otherwise untouched, and its existing test suite passes unmodified)
    so both variants share exactly one creation code path — nothing about
    how an assignment actually gets created differs between them, only
    how each variant's input rows get built.
  - Success dialog: `ConfirmResultView` (`workload-import-client.tsx`) was
    exported and reused as-is by the new flow — `WorkloadImportConfirmResult`
    is identical regardless of which variant produced it, so "X new, Y
    skipped, Z errors," the created-assignments table, and the Done /
    "Continue to auto-generate timetable" buttons are unchanged, byte-for-
    byte the same experience either way.
  - Tests: new `class-actions.test.ts` (21 cases — template generation via
    a real `XLSX.read` round-trip on the returned base64 rather than
    mocking `xlsx` itself, same convention as the Timetable export tests;
    every preview validation branch including the
    real-course-but-wrong-class-plan case; dean scoping; confirm's
    row-assembly and delegation to a mocked `finalizeWorkloadImport`).
    Existing `actions.test.ts` (16 cases) re-run unmodified and still
    passes, confirming the extraction didn't change
    `confirmWorkloadImport`'s external behavior. Full suite: 598 passing.
  - Not yet visually verified end-to-end in a browser — same
    `next/navigation`-requires-a-real-authenticated-request constraint
    noted on every other post-Phase-7 UI addition in this log; `tsc
    --noEmit`, ESLint, and the full Vitest suite were all run clean.

Business rule change — Per-semester-level workload Excel import becomes
  the primary flow (branch `main`): revises the per-class workload import
  from the previous phase (kept, demoted to a secondary "By Class" tab)
  with a new PRIMARY selection step — pick one or more
  `Class.currentSemesterNumber` levels (e.g. 1 and 3 together) instead of
  a single class; every class currently at those levels gets pulled into
  ONE combined template. `admin/workload-import/` now shows THREE Tabs:
  **"By Semester (Recommended)"** (new, default —
  `semester-schema.ts`/`semester-actions.ts`/
  `semester-workload-import-client.tsx`), **"By Class"** (the previous
  phase's flow, unchanged, now the secondary "quick single-class fix"
  option), **"Bulk Import (Advanced)"** (the original multi-class flow,
  still completely untouched). All three continue to share ONE
  `finalizeWorkloadImport` helper (`actions.ts`) for the actual
  create/audit/summary work.
  - **Selection**: a `Checkbox` row, one per semester level that actually
    has at least one class with a course plan (`panel.tsx`'s
    `getSemesterNumberOptions` — a pure aggregation over the SAME
    already-filtered class list `getWorkloadImportClasses` builds for the
    "By Class" tab, computed with zero extra queries, and guaranteeing the
    two pickers can never disagree about which levels are usable).
  - **Template generation** (`downloadSemesterWorkloadTemplate`): resolves
    every class (dean-scoped) at one of the picked levels, then — critically
    — filters `ClassCoursePlan` rows to EXACTLY each class's OWN
    `currentSemesterNumber` (`getRelevantPlanRows`), not just "any plan row
    at one of the selected levels." This distinction is real: a class could
    have plan rows filed under a level other than its current one (the
    curriculum template recurs across 1..8), and if that other level
    happens to ALSO be selected in the same request, a naive "classId IN
    (...) AND semesterNumber IN (selected)" query would incorrectly pull
    that class's rows from the WRONG level into the template. Verified with
    a dedicated regression test. One row per (class, course) pair,
    `semester_level`/`class`/`course_code`/`course_name` all pre-filled
    from the DB — only `lecturer`/`credit_hours` blank.
  - **Preview** (`previewSemesterWorkloadImport`) re-validates against a
    freshly-resolved candidate set (same dean scope + picked levels): the
    `class` cell is matched only within that set; `course_code` is matched
    only against THAT SPECIFIC row's resolved class's own plan (keyed by
    `${classId}:${courseCode}`, never a bare course-code lookup) — a code
    that's real but belongs to a DIFFERENT selected class's plan is
    exactly as invalid as an unknown one, covered by its own regression
    test. Duplicate-in-file is keyed by `(classId, courseId)`; the
    one-lecturer-per-course+class+semester conflict check is unchanged in
    spirit, just re-scoped across every candidate class instead of one. A
    lecturer appearing across multiple courses/classes/levels in the same
    file is normal — handled by the same per-row create loop Bulk Assign
    already uses, nothing special-cased.
  - **Confirm** (`confirmSemesterWorkloadImport`) re-resolves the
    candidate class set fresh (defense in depth — never trusts anything
    round-tripped from the client) and SILENTLY DROPS any row whose class
    fell out of scope since preview, keeping the rest of the batch going
    (mirrors the original Bulk variant's own confirm behavior, not the
    single-class "throw if the one target disappeared" behavior of the By
    Class variant — appropriate here since a request can legitimately span
    many classes and losing one shouldn't sink the rest). Builds the full
    `WorkloadImportRow` per row from ITS OWN class's resolved room/
    studyMode and hands the whole batch to `finalizeWorkloadImport` in one
    transaction, exactly matching requirement 3's "creates/updates
    LecturerCourseAssignments across ALL the classes/semesters included in
    this one file, in one transaction."
  - **Success dialog enhancement**: `ConfirmResultView`
    (`workload-import-client.tsx`, shared by all three variants) now shows
    "across N classes / M semester levels" whenever a result's created
    assignments span more than one class — computed from
    `createdAssignments` itself (`classId`/`classCurrentSemesterNumber`),
    not a new dedicated field, so this is a free improvement for the Bulk
    variant too whenever IT happens to span multiple classes, not just new
    behavior gated to this phase's flow. "Continue to auto-generate
    timetable" is completely unchanged — selecting levels 1 and 3 here
    lines up directly with the generator's existing sequential odd-level
    order (confirm import → generate/confirm semester 1 → generate/confirm
    semester 3), satisfying requirement 5 with zero changes to
    `admin/auto-timetable/`.
  - Tests: new `semester-actions.test.ts` (23 cases — template generation
    via a real `XLSX.read` round-trip, including the
    stray-plan-row-at-a-different-selected-level regression; every preview
    validation branch including the real-course-but-wrong-class's-plan
    case and cross-class OK rows in one file; dean scoping; confirm's
    per-class row assembly, the out-of-scope-row-silently-dropped
    behavior, and delegation to a mocked `finalizeWorkloadImport`).
    `class-actions.test.ts` (21 cases, previous phase) and `actions.test.ts`
    (16 cases, original bulk flow) both re-run unmodified and still pass.
    Full suite: 621 passing.
  - Not yet visually verified end-to-end in a browser — same
    `next/navigation`-requires-a-real-authenticated-request constraint
    noted on every other post-Phase-7 UI addition in this log; `tsc
    --noEmit`, ESLint, and the full Vitest suite were all run clean.

Update this section whenever a phase is completed.
