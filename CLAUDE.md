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
  **Session policy** (applies uniformly to every role — admin/dean/
  lecturer/student, no "remember me"/"stay logged in" feature exists
  anywhere in the app): the session cookie is a browser-SESSION cookie —
  no `maxAge`/`expires` is ever set on it (`app/login/actions.ts`) — so
  the browser discards it on close and a new browser session always
  requires a fresh login, even if the underlying DB `Session` row is
  still otherwise valid. On top of that, the DB `Session` row itself has
  TWO independent expiry mechanisms, both enforced in `proxy.ts` (every
  request) and again in `lib/auth.ts`'s `getCurrentUser()` (defense in
  depth, same dual-check pattern as before this policy existed):
  `expiresAt`, an absolute 7-day ceiling set at login and never extended,
  and `lastActivityAt`, a sliding 30-minute idle timeout
  (`IDLE_TIMEOUT_MS` in `lib/auth.ts`) bumped on every authenticated
  request in `proxy.ts` — the one gate every request passes through,
  including Server Actions (which POST to the same route). Either expiry
  is treated identically: the request is rejected, the cookie is cleared,
  and the browser is redirected to `/login` — an idle-timeout redirect
  additionally carries `?reason=idle_timeout`, which the login page
  (`app/login/page.tsx`) surfaces as "Your session expired due to
  inactivity — please log in again." An idle-timed-out `Session` row is
  never deleted (same "just treat it as invalid" convention the
  pre-existing `expiresAt` check already used) — it simply keeps
  evaluating as idle-expired on every future request, since
  `lastActivityAt` is never bumped for a session nothing is
  authenticating with anymore.
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
  selected level, and a **"Move semester"** bulk action that re-points
  EVERY course planned for the selected class at one semesterNumber to a
  different semesterNumber in one transaction (the "bulk-fix a mistake"
  case — e.g. the whole plan entered under level 3 instead of 5).
  Conflict handling is **merge with duplicate-skip**: a source course
  already planned at the target level can't have its row's semesterNumber
  updated (collides with the existing target row on
  `@@unique([classId, semesterNumber, courseId])`), so those source rows
  are DELETED and only the non-colliding ones are moved (one
  `deleteMany` + one `updateMany`, both bounded, no per-row loop).
  The confirm dialog previews the source course list, the target level's
  current count, exactly which courses will be skipped as duplicates, and
  — since `LecturerCourseAssignment`/`TimetableSlot` key on the
  academic-calendar `semesterId`, NOT `semesterNumber`, so the move never
  touches them — an amber warning counting any existing assignments (and
  their timetable sessions) for that class that reference the moved
  courses, telling the admin to review those separately. Audited as
  `COURSE_PLAN_SEMESTER_MOVED` (class, source/target semesterNumber,
  moved/skipped counts, moved course names, by whom).
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
  - **Leave hours are computed from linked timetable sessions at logging
    time, then snapshotted** — a LEAVE_NOTICE no longer just counts as
    one entry, it carries a real `leaveHours` number. New
    `DailyLogEntrySession` join table (`dailyLogEntryId`, nullable
    `timetableSlotId`, migration `20260830230016_daily_log_leave_sessions`)
    — one row per `TimetableSlot` a leave covers, so a single entry can
    span several sessions on the same day. In the create form (both the
    lecturer and student "About" flows, at `/admin/daily-log` and
    `/dean/daily-log`), once a LEAVE_NOTICE has a person + a date, a live
    lookup (`getLeaveNoticeSessions` action -> shared
    `fetchLeaveSessionSlots` in `queries.ts`) shows that date's
    day-of-week sessions for them — **lecturer**: every session they
    teach that day across any class; **student**: their own class's
    sessions that day (resolved via `Student.classId`) — both scoped to
    the active `Semester`. Checkboxes + "Select all"; the live total is
    the sum of each checked session's own `endTime − startTime` span
    (`lib/leave-hours.ts`'s `sessionDurationHours`/`sumSessionHours` —
    `TimetableSlot` has NO FK to `Shift`, so a slot's stored times ARE
    its real length, whether from a shift preset or hand-typed). A day
    with NO sessions (a day off, or no timetable built yet) falls back to
    the pre-existing simple date+note entry with `leaveHours = null` and
    zero linked sessions. On submit, `createDailyLogEntry` re-resolves
    the selected slot ids through the SAME `fetchLeaveSessionSlots` (a
    tampered/stale id that isn't one of that person's real sessions for
    that day is silently dropped), computes `leaveHours` as their summed
    span, and writes the entry + `DailyLogEntrySession` rows in one
    transaction (only when there are session rows; the common
    note/problem path stays a plain single create). Every session row
    also SNAPSHOTS `courseName`/`className`/`startTime`/`endTime`/`hours`
    — so the entry stays fully readable and its total never shifts even
    if the slot is later retimed or deleted (`timetableSlotId` is
    `SetNull` on slot delete, never Cascade). `leaveHours` is NEVER
    recomputed from the linked sessions afterward. The admin/dean list
    and the lecturer/student "My Leave Notices" widgets show each entry's
    covered sessions (course + time) and its hours; the widgets' header
    now shows a real total — `getMyLeaveHoursSummary` sums the stored
    `leaveHours` snapshot (via `prisma.aggregate`) across ALL the
    person's leave notices in the active semester (the widget lists only
    the 5 most recent but totals every one), e.g. "12.5 hours of leave
    this semester" instead of a bare notice count. Audited: `newValue`
    on `DAILYLOG_CREATED` gained `leaveHours` + `sessionCount`.
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
  - **Changing `Class.roomId` bulk-propagates to EVERY existing
    `TimetableSlot` for that class**, in the SAME transaction as the class
    update — not just future sessions (`updateClass` in
    `admin/classes/actions.ts`). This DOES reset any per-session room
    override on those slots (they all move to the new room) — a
    deliberate, decisive action; re-apply a genuine lab exception
    afterward. First, `checkNewRoomForClassSlots` conflict-checks the NEW
    room against every affected session's own day+time (per its own
    `semesterId` — a room conflict is always same-semester) via the same
    `findTimetableConflicts`; if the new room is already booked by a
    DIFFERENT class at any of those times the WHOLE class update is
    blocked (no writes) with a message listing the specific clashes. A
    same-class session at the new room+time is NOT a blocker (the class
    moves together). Clearing the room to null never touches slots
    (`TimetableSlot.roomId` is required). On success:
    `class.update` + one `timetableSlot.updateMany`, audited as
    `CLASS_ROOM_BULK_UPDATED` (class, old room, new room, session count),
    and the client toasts "N sessions moved to <room>". `updateClass` now
    returns `{ roomChange: { movedSessions, newRoomName } | null }`.
  - **Manual room conflict → immediate "open rooms for this shift"
    picker** (BUG-2 fix): when a manual placement (drag-and-drop grid, or
    the single-slot Add/Edit dialog) hits a room-ONLY conflict (same
    room, same day+time, different class — and NO lecturer/class conflict,
    since another room can't resolve those), the UI immediately offers the
    rooms that ARE free at that exact day+time to swap in with one click,
    instead of a dead-end error. `getOpenRoomsForSlot(query, excludeSlotId?)`
    (`admin/timetable/actions.ts`, `timetable.manage`) runs the same
    per-room `findTimetableConflicts` ROOM check the create/update
    pre-check uses, over `getRoomOptions()`, optionally scoped to one
    `campusId` (the conflicting room's campus — same "identically-named
    rooms across campuses" convention as the grid's Room-narrows-by-Campus
    filter); returns `{ openRooms, roomsInScope }` so the UI shows "No
    rooms available for this shift" (`roomsInScope > 0`) vs "No rooms
    exist" distinctly. `createTimetableSlot`/`updateTimetableSlot` prefix
    the thrown message with `ROOM_CONFLICT_PREFIX` ("ROOM_CONFLICT::",
    defined in `lib/timetable-conflicts.ts`, stripped for display by
    `lib/action-error.ts`) ONLY when every conflict is a ROOM conflict —
    that's the signal both manual clients key on
    (`isRoomOnlyConflictError`) to open the picker; the drag grid then
    retries the same drop with the picked room. The auto-generate
    algorithm is UNCHANGED — its backtracking already handles this; the
    picker is the human-in-the-loop case only.
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
    Admin/Dean's own view is a single unified, read-only GRID (Shift-rows
    x Day-columns, one per studyMode/period structure group, reusing
    `ScheduleGrid` in non-interactive mode — see the "Timetable 'super
    filter' report view is now a GRID" roadmap entry below, the
    authoritative description of the current Admin/Dean UI: Now/shift/day/
    Class/Lecturer/Room/Campus/Semester filters, a per-cell ⋯ Edit/Delete
    menu opening the Add/Edit dialog, Export Excel); this bullet is
    intentionally not duplicating it. The Add/Edit
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
  - **Period (Morning/Afternoon) — FT-only**: a second, independent
    FT-only dimension on top of studyMode. `Class.period` and
    `Shift.period` (`Period` enum: `MORNING` | `AFTERNOON`, nullable at
    the DB level, migration `20260806155730_ft_period`) — "Subax"
    (Morning) vs "Galab" (Afternoon). PT has no period concept at all;
    both fields are always `null` for PT (app-enforced, not a DB
    constraint — `composeClassData`/`composeShiftData` force it). Required
    going forward whenever studyMode is FT: the Class and Shift
    create/edit forms both show a required Period picker only when FT is
    selected (hidden entirely for PT), enforced by a Zod `.refine` on each
    schema. `Class.period` is set explicitly on EACH class row at
    creation/edit — it does NOT inherit from a predecessor class at
    promotion (a batch can switch periods across semesters, e.g. Subax
    through semester 3, Galab from semester 5 on), matching how none of
    the other per-row batch fields inherit either. The auto-timetable
    generator (`lib/auto-timetable.ts`) restricts an FT assignment's
    shift search to ONLY shifts sharing its class's own period — a
    Morning-period class only ever tries Subax shifts, an
    Afternoon-period one only ever tries Galab, with no fallback across
    periods even when the matching-period shifts are fully booked (an FT
    session that can't be placed within its own period lands in
    Unscheduled, never spills into the other period). PT scheduling is
    completely unaffected — no period filtering is applied to it at all.
    An FT class/shift with no period assigned yet (pre-existing rows from
    before this field existed) is never guessed: `previewAutoTimetableBatch`
    reports it via `classesWithoutPeriod` (same "report and exclude"
    treatment as `classesWithoutRoom`) with a direct link to set it, and
    the generator's shift-override picker is itself narrowed to the
    class's own period so an admin/dean can't even pick a wrong-period
    override shift. The MANUAL tools enforce the identical restriction,
    via their own separate client-side filtering (they don't route
    through `lib/auto-timetable.ts`): the drag-and-drop weekly builder's
    grid rows (`build-timetable-client.tsx`) and the single-slot Add/Edit
    dialog's shift picker (`timetable-client.tsx`) both filter
    `shiftsForClass` by the selected class's own period for FT, and the
    weekly builder additionally blocks opening the grid at all for an FT
    class with no period set (same amber-block-with-a-link pattern as its
    "no room assigned" check) — see the "Period filtering was missing
    from the manual Timetable Builder" changelog entry below for why this
    needed a separate fix from the auto-generator's own restriction.
  - **Cross-period override — manual, per-session, opt-in ONLY, never
    automatic**: `TimetableSlot.crossPeriodOverride` (`Boolean @default(false)`,
    migration `20260807123111_timetable_slot_cross_period_override`) lets
    an admin/dean deliberately place ONE exceptional session on the
    OTHER period's shift (a Morning-period class occasionally using a
    Galab shift, or vice versa) without weakening the strict default
    above. The auto-generate algorithm (`lib/auto-timetable.ts`) is
    untouched by this and structurally CANNOT use it — `ScheduledSession`
    carries no such field, so a batch-confirmed slot always gets the
    column's own `false` default; an assignment the algorithm can't place
    within its own period still lands in Unscheduled exactly as before,
    for the admin/dean to place manually with this override if they
    choose to. Enforced/offered manually on every session-editing
    surface, all sharing the SAME `ScheduleGrid` component
    (`components/timetable/schedule-grid.tsx`) rather than three separate
    implementations:
    - `ScheduleGridRow` gained an optional `crossPeriod` marker, and
      `ScheduleGridProps` gained `crossPeriodRows` (the OTHER period's
      shifts, supplied by the caller ONLY for an FT class with a period
      set — empty/omitted for PT or a period-less FT class, so the
      control never even appears there) plus `onSetCrossPeriodOverride`.
      A small "Show cross-period shifts (N)" toggle appears above the
      grid whenever `crossPeriodRows` is non-empty; OFF by default every
      time (never remembered as "on" — matches "the default stays
      strict"). Turning it on ADDS those as extra, visually tinted rows
      (violet, with a "cross-period" row label) rather than mixing them
      silently into the normal row list. Dropping a chip or moving a
      session onto one of those extra rows is what actually sets the
      flag — the ROW itself is the intent signal, so `scheduleChipInClass`/
      `moveSessionInClass` (`lib/auto-timetable-preview-state.ts`) and
      `build-timetable-client.tsx`'s `scheduleAssignment`/`moveSlot`
      simply derive `crossPeriodOverride` from `row.crossPeriod` — moving
      a cross-period session back onto a normal row clears the flag
      again, since it always reflects CURRENT placement, not a
      separately-tracked intent.
    - `PlacedCard` (full scale — every scale except the truly-compact
      mini-grid, which has no inline editing at all) also gained an
      explicit "Cross-period override" checkbox plus, once checked, an
      inline shift-picker offering `crossPeriodShiftOptions` (the same
      list as `crossPeriodRows`) — picking one fills the time fields the
      same "shift-pick is a time autofill convenience" way every other
      shift picker in this app already works. The checkbox alone (no
      shift picked) is enough to flag an already-placed session someone
      retimed by hand. Wired through a new pure
      `setCrossPeriodOverrideInClass` (flag-only, no conflict re-check
      needed since day/time/room are untouched) for the auto-generate
      preview, and `editSessionTimeInClass` gained an optional 5th
      `crossPeriodOverride` param (omitted = preserve the session's
      current flag unchanged; provided = set it explicitly) so the same
      function serves both a plain retype and the inline picker.
      `build-timetable-client.tsx`'s live `updateSlot` mirrors this
      exactly (patch omitted = preserve `before.crossPeriodOverride`).
    - The standalone single-slot Add/Edit dialog
      (`admin/timetable/timetable-client.tsx`) gained the identical
      checkbox (shown only when `crossPeriodEligible` — FT with a period
      set) which widens ITS "Use a shift" picker to also list the other
      period's shifts (each labelled "— cross-period" in that dropdown).
    - Visual flag (requirement 5): a violet left-border/badge — distinct
      from the amber spacing-fallback `flagged` treatment — at every
      scale, including a violet-tinted compact pill in the mini-grid, so
      it's unambiguous from the fallback flag at a glance. The two are
      never realistically both true on the same session in practice
      (`flagged` only comes from the algorithm, `crossPeriodOverride`
      only from a manual action, and any manual edit already clears
      `flagged`), but the styling still prioritizes `flagged` if it ever
      happened.
    - Hard conflict rules (room/lecturer/class) are completely unaffected
      — `findTimetableConflicts` has no period awareness at all, so they
      apply identically regardless of which period's shift is used.
    - Tests: `lib/auto-timetable-preview-state.test.ts` gained coverage
      for deriving the flag from `row.crossPeriod` on
      schedule/move (including clearing it when moved back to a normal
      row), `editSessionTimeInClass`'s preserve-vs-explicit-set behavior,
      and a full `setCrossPeriodOverrideInClass` suite.
      `admin/timetable/actions.test.ts` and
      `admin/auto-timetable/actions.test.ts` each gained a persistence
      test confirming `crossPeriodOverride: true` survives through to the
      actual `prisma.timetableSlot.create`/`update`/`createMany` call.
      `crossPeriodOverride` was made a plain required `z.boolean()` in
      both `admin/timetable/schema.ts` and `admin/auto-timetable/schema.ts`
      (not `.optional().default(false)`) specifically because an
      optional-with-default field's diverging input/output types broke
      react-hook-form's `zodResolver` generics in `timetable-client.tsx`
      — every real caller already supplies the field explicitly (every
      form default/reset, the live builder, every test fixture, and
      `CommitSession` which always carries it), so requiring it costs
      nothing.
  - **Bulk update period** (Academic Structure > Classes, `structure.manage`
    — ADMIN only, same as every other Class action, no new permission key):
    a "Bulk update period" button opens a two-step dialog for changing many
    FT classes' period at once instead of one-by-one. Step 1: Program and
    Semester-level filters narrow a checkbox list of active FT classes
    (client-side only, filtered from the already-loaded full class list —
    PT classes and deactivated classes are excluded from the list
    entirely, never offered). Step 2 (`previewBulkClassPeriodUpdate`, a
    read-only server call): shows each selected class's CURRENT period
    plus whether it already has any `TimetableSlot` rows, with an amber
    warning ("N of these classes already have a scheduled timetable under
    their current period — changing period will NOT move existing
    sessions automatically...") whenever any do — changing period never
    touches existing `TimetableSlot` rows, by design, so this is purely an
    informational flag, never a block. Picking the new period and
    confirming (`bulkUpdateClassPeriod`) re-verifies every id is still a
    real, currently-FT class server-side (never trusts the client's own
    filtering — a non-FT/no-longer-existing id is silently excluded and
    counted in `skipped`, not force-updated) and writes via ONE
    `class.updateMany` call (a single atomic `UPDATE ... WHERE id IN
    (...)`, not a per-row loop) — genuinely one transaction, no
    `$transaction` wrapper needed for a single statement. Audited as
    `CLASS_PERIOD_BULK_UPDATED` with `oldValue` (each class's id/name/
    period BEFORE the change) and `newValue` (the new period + each
    class's id/name) — a real old->new diff, not just counts.
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
  - **Lecturer availableDays — OPTIONAL per-lecturer availability, DAY
    or DAY+SHIFT granularity, HARD constraint when set, RE-ENTERED EVERY
    GENERATION CYCLE**: a `LecturerAvailability` join table (`id,
    lecturerId, dayOfWeek, shiftId` nullable — migration
    `20260807160000_lecturer_availability_day_shift`, replacing the
    earlier flat `Lecturer.availableDays DayOfWeek[]` column, which this
    migration drops) restricts which (day, shift) combinations a
    specific lecturer can ever be scheduled on. Zero rows for a lecturer
    = fully unrestricted (today's default). A day can be restricted at
    either granularity: one row with `shiftId = null` means "every shift
    that day is allowed" (day-level only, the original granularity); one
    or more rows with `shiftId` SET for that same day means "ONLY those
    shifts on that day" (day+shift level — e.g. Tue: Subax 1st+2nd only,
    Sat: Subax 2nd+3rd only, different shifts on different days for the
    same lecturer). A day never mixes both row shapes — guaranteed by
    the app layer (never a DB constraint), since the save action always
    replaces a lecturer's ENTIRE rule set atomically (delete-all-then-
    recreate), never a partial merge. The pure logic lives in
    `lib/timetable-days.ts`: `LecturerAvailabilityDayRule`
    (`{dayOfWeek, shifts: LecturerAvailabilityShiftRef[]}`, empty
    `shifts` = whole day) is the shape every consumer below passes
    around; `restrictedDaysForLecturer` (day-level intersection),
    `isShiftAllowedForLecturerOnDay` (the per-cell (day,shift) check),
    `formatAvailabilityRules` (e.g. "Tue (Subax 1aad, Subax 2aad) and
    Sat"), and `groupLecturerAvailabilityRows` (raw DB rows ->
    `LecturerAvailabilityDayRule[]`, the one place this grouping logic
    lives, reused by every server-side fetch) are all pure/unit-tested.
    **NOT a permanent Lecturer Registration field** — a lecturer's
    availability can change every semester, so it is deliberately set
    fresh as part of EACH auto-generate run rather than once at
    registration (an earlier version of this feature put a checkbox-
    per-day field on Lecturer Registration/Edit; that was reverted in
    favor of the wizard step below once it became clear availability
    isn't a one-time fact about a lecturer). Lecturer Registration
    (`admin/lecturers/`) does not ask for it at all.
    - **The "Lecturer availability" wizard step**
      (`admin/auto-timetable/lecturer-availability-step.tsx`): inserted
      into the auto-generate flow, between picking a semester level and
      the algorithm actually running for that level's batch. Lists
      every DISTINCT lecturer among that batch's schedulable
      assignments (deduped by lecturerId, derived client-side from the
      already-loaded `CreatedAssignmentSummary[]` — no extra query).
      Each lecturer's row is a collapsible list of day checkboxes;
      checking a day reveals an optional shift multi-select scoped to
      that lecturer's OWN FT/PT shift catalog (the union of studyModes
      among their own assignments in this batch) — leaving every shift
      box unchecked for a checked day means "any shift that day," same
      as the original day-only granularity; checking specific shifts
      narrows it further. Pre-filled from whatever `lecturerAvailability`
      that assignment already carries (the DB value as of when the
      assignments were fetched — i.e. from a prior generation run, if
      any); a lecturer with an existing restriction starts expanded, an
      unrestricted one starts collapsed. Confirming
      (`saveLecturerAvailableDaysForGeneration`,
      `admin/auto-timetable/actions.ts`, gated on `timetable.generate`
      — not `user.manage`, since this is part of the generation
      workflow) REPLACES each listed lecturer's entire
      `LecturerAvailability` rule set in one transaction (a per-row
      `tx.lecturerAvailability.deleteMany` + `createMany` — necessarily
      a delete-then-recreate, since each lecturer/day gets a genuinely
      different value, unlike `CLASS_PERIOD_BULK_UPDATED`'s single
      shared new value — with `BULK_TRANSACTION_OPTIONS`, the
      established variable-sized-batch-loop convention), scoped to
      lecturers the caller can actually see (`lecturerDeanWhere` for a
      Dean, silently skipping the rest — never trusting client-supplied
      lecturer ids) and defended against a stale/deleted shift id
      (silently dropped, never written as a dangling reference — a
      `prisma.shift.findMany` existence check before writing), audited
      as `LECTURER_AVAILABLE_DAYS_SET_FOR_GENERATION` with old/new
      `{dayOfWeek, shiftIds}` per lecturer, THEN proceeds straight to
      `previewAutoTimetableBatch` (which reads the just-written values
      fresh from the DB, so the algorithm sees exactly what was just
      set — no extra plumbing needed for that part).
    - **Shown once per level per session, re-shown for a different
      level, and explicitly re-openable**: a per-level
      `availabilityConfirmedKeys` set (`auto-timetable-generator-
      client.tsx`) gates the existing auto-preview effect — selecting a
      level whose key isn't in the set shows the availability step
      INSTEAD of auto-fetching a preview; confirming the step both
      updates the set and fetches the preview directly (the effect's
      own `[effectiveKey]`-only dependency array is intentionally left
      alone, matching its existing pattern for `shiftOverrideCounts`).
      Switching to a level not yet visited this session (a DIFFERENT
      `semesterId:level` key) always shows the step fresh — this is
      what makes "re-run generation for a different semesterNumber
      later, set different days/shifts for the same lecturer" hold,
      since `LecturerAvailability` is one shared rule set per lecturer,
      overwritten per run, not a per-level snapshot. An "Edit lecturer
      availability for this level" link (shown once schedulable
      assignments exist) lets the admin/dean deliberately re-open the
      step for the level they're currently on, without switching away
      and back. A local `savedAvailabilityByLecturer` map (keyed by
      lecturerId, valued `LecturerAvailabilityDayRule[]` resolved back
      from the save payload's raw shift ids against the already-loaded
      shift catalog) layers ON TOP of the (never refetched mid-session)
      `createdAssignments` prop when pre-filling the step and when
      building `assignmentMetaById`'s own `lecturerAvailability` (used
      when manually dragging a previously-unscheduled chip in the
      overview) — so re-opening the step, or dragging a chip, after a
      save earlier in the SAME session reflects what was actually just
      saved, not the page-load-time snapshot.
    - Nothing about how the restriction is READ changed in kind — every
      consumer below still just reads `Lecturer.availability` (now at
      whichever granularity was set) exactly as before, regardless of
      where or when it was last set; each was upgraded from a flat
      `DayOfWeek[]` check to the richer `LecturerAvailabilityDayRule[]`
      check:
    - **Auto-generate** (`lib/auto-timetable.ts`): for each assignment,
      `restrictedDaysForLecturer` narrows the class's own FT/PT+Period
      valid days down to the intersection with the lecturer's available
      DAYS (day-level only — a shift-restricted day is still "available"
      at this stage; empty `lecturerAvailability` leaves the class's
      valid days untouched — zero behavior change for an unrestricted
      lecturer). Within that day set, `findFirstOpenSlot` additionally
      checks `isShiftAllowedForLecturerOnDay(day, shift.id, ...)` for
      EVERY (day, shift) pair it tries — so a day present in the
      day-level set can still reject a specific shift not on that day's
      own allowed list. Both placement passes (the day-reuse spacing
      rule and its fallback) search within this same restricted
      (day,shift) space — the fallback pass may still reuse the SAME
      allowed day at a DIFFERENT allowed shift/time, but it can never
      use a day OR a shift outside the restriction; an explicit
      per-assignment shift OVERRIDE is checked the same way and is
      NEVER exempt from this hard constraint (unlike its exemption from
      the day-reuse fallback). Reported as `Unscheduled` with a specific
      reason naming the exact restriction via `formatAvailabilityRules`
      — either "none of those day(s) are valid teaching days for this
      class" (zero day overlap at all, checked upfront, before any
      shift-combo work) or "no open slot within those" (the day overlap
      exists but nothing in the allowed (day,shift) space is free).
    - **Manual Timetable Builder & fullscreen auto-generate review**:
      `components/timetable/schedule-grid.tsx`'s `ScheduleGrid` — the
      one shared drag-and-drop component behind the Timetable Builder,
      the auto-generate overview's mini-cards, and its fullscreen modal
      — greys out and disables (as a real drop target, via dnd-kit's
      `disabled` droppable option, not just a CSS treatment) every CELL
      (a specific Shift-row x Day-column intersection — `GridCell`'s
      `restrictedCellBlocked`, computed via `isShiftAllowedForLecturerOnDay(day,
      row.id, ...)` since a grid row's id IS the real Shift id it
      represents) not allowed for the CURRENTLY-DRAGGED chip/session's
      own lecturer, for the duration of that one drag only. A
      day-level-only restriction blocks every cell in that whole
      day-column (same as before this upgrade); a day+shift restriction
      blocks only the non-listed shift-ROWS within that one day,
      leaving the allowed shift-rows droppable — this is what makes "a
      shift-restricted day greys out just the disallowed shift rows for
      that day, not the whole day" hold. Per-drag, not per-row/per-class
      — one class's grid can contain sessions from several different
      lecturers with different (or no) restrictions; dragging an
      unrestricted lecturer's chip never greys anything out.
      `ScheduleGridSession`/`ScheduleGridChip` both carry an optional
      `lecturerAvailability: LecturerAvailabilityDayRule[]`, threaded
      through end-to-end: `LecturerCourseAssignment`-adjacent queries
      (`getAssignmentOptions`/`getTimetableSlots` in
      `admin/timetable/queries.ts`, whose shared `lecturerWithAvailability`
      include resolves `lecturer.availability` with each row's `shift`
      relation — a plain `lecturer: true` only returns scalars, never
      relations), `AssignmentToSchedule`/`ScheduledSession`/
      `UnscheduledItem` (`lib/auto-timetable.ts`), and the auto-generate
      preview's local editing model (`PreviewSession`/`PreviewChip`/
      `PreviewAssignmentMeta` in `lib/auto-timetable-preview-state.ts`).
    - **Single-slot Add/Edit dialog** (`admin/timetable/
      timetable-client.tsx`): the Day dropdown's options are narrowed by
      `restrictedDaysForLecturer` on top of the existing FT/PT-narrowing
      (day-level, unchanged in kind); the Shift picker (`shiftsForClass`)
      gained a NEW narrowing on top of its existing period-based one —
      once a day is picked, `isShiftAllowedForLecturerOnDay(pickedDay,
      shift.id, ...)` filters it down to exactly that day's own allowed
      shifts, so picking Tue only ever offers Tue's allowed shifts and
      picking Sat only Sat's, even for the SAME lecturer/assignment. A
      small note (via `formatAvailabilityRules`) explains the narrowing
      when only some days/shifts are hidden; an amber "no day can be
      picked" banner appears when the restriction leaves zero valid days
      for the selected assignment's class, pointing at the "Lecturer
      availability" wizard step (Workload Import & Auto-Timetable)
      rather than Lecturer Registration — there's no per-lecturer edit
      surface left on the Lecturers page to link to.
    - **Workload Excel import validation** (all three variants — Bulk,
      By Class, By Semester): `lecturerAvailabilityConflictReason`
      (`lib/timetable-days.ts`, now taking `(studyMode, period, rules)`)
      flags a row as an ERROR in either of two cheap-to-detect,
      unambiguous cases — never a full bin-packing feasibility check
      against the row's own credit_hours, which stays the generation
      algorithm's job: (1) the matched lecturer's availability has ZERO
      DAY overlap with the target class's valid days at all (same check
      as before this upgrade), or (2) NEW — every day that DOES overlap
      has a shift-level restriction whose listed shifts all belong to a
      DIFFERENT studyMode/period than the class needs (e.g. every
      allowed shift on the one overlapping day is an Afternoon shift
      while the class is Morning) — so literally no (day,shift)
      combination could ever work. A PARTIAL match (some usable day
      exists) is never flagged at import time — the row is still
      genuinely schedulable, just more constrained. `WorkloadImportRow`
      (`admin/workload-import/schema.ts`) carries `lecturerAvailability`
      (the full `LecturerAvailabilityDayRule[]`, including each shift's
      name/studyMode/period so it round-trips without another lookup)
      through to `CreatedAssignmentSummary` (and therefore into the
      auto-generate preview/overview), resolved fresh from the DB via
      `groupLecturerAvailabilityRows` at confirm time for the By
      Class/By Semester variants (their own narrower round-tripped row
      shapes don't carry it) rather than trusted from the client.
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
  `Student.email` is a SEPARATE, optional, real address (nullable, format-
  validated when given, never required — same "validate-if-present, skip-
  if-blank" pattern as `Student.phoneNumber`; captured on the Student
  Registration form and the Students bulk-import `email` column). It is
  NOT a login identifier (that's still `studentNo`) — it exists purely as
  a real notification channel: when it IS set, generating that student's
  account (single or "Generate accounts by class") ALSO emails their
  username + temp password automatically (`emailStudentCredentials`,
  `STUDENT_LOGIN_CREDENTIALS_EMAIL` template — a REAL send via Resend, not
  a share link, since email carries no ban risk), and publishing an
  assessment's results ALSO emails every affected student who has one a
  mark-free "your result is available, log in to view it" notice
  (`emailResultsPublished`, `RESULTS_PUBLISHED_EMAIL` template —
  deliberately NO `{mark}` placeholder, for privacy), on top of the
  existing in-app bell. When `Student.email` is ABSENT the existing
  fallbacks are unchanged: credentials are shown once + CSV-downloaded,
  results are bell-only. Both emails are fire-and-forget (see the WhatsApp
  Notifications section's email bullet) — a missing address, an unset
  `RESEND_API_KEY`, or a provider failure NEVER blocks account generation
  or result publishing.
  The ONE deliberate exception: a lecturer's still-unused temp password
  is also kept **encrypted at rest** (`User.pendingCredential`, AES-256-GCM,
  `lib/credential-crypto.ts`) so the persistent "Send credentials" action
  on Lecturer Accounts can re-send the SAME still-valid credential over
  WhatsApp without a password reset — decrypted only server-side, wiped
  the moment the lecturer changes their password (`mustChangePw` -> false)
  or an admin resets it. Never plaintext at rest; null when the
  `CREDENTIAL_ENCRYPTION_KEY` env var isn't configured (the feature then
  just degrades — the entry point is disabled).
- `Student.isActive` (`Boolean @default(true)`) is the student's OVERALL
  status (e.g. graduated, withdrawn, suspended) — a THIRD, independent
  concept alongside two that already existed: `EnrollmentStatus` (per
  COURSE, on `StudentCourseEnrollment` — ACTIVE/TRANSFERRED/DROPPED/
  COMPLETED) and `User.isActive` (the login account's own gate, moot for
  the many students with no account at all). Toggled manually from
  Student Registration's row menu (`deactivateStudent`/`reactivateStudent`,
  `students.manage`, audited as `STUDENT_DEACTIVATED`/
  `STUDENT_REACTIVATED`) — same Deactivate/Reactivate-never-delete
  convention as Users/Rooms/Campuses/Shifts, never a real delete. Setting
  it to false does NOT touch anything else — the student stays fully
  visible in every table/report, keeps every existing enrollment/result
  untouched, and can still log in if they have an account (deactivating
  the account itself is still the separate, existing `User.isActive`
  toggle on Admin -> Users). The ONE behavior change: `lib/enrollment.ts`'s
  two auto-enroll functions (`autoEnrollStudentIntoClassCourses`/
  `autoEnrollClassIntoAssignment`) both skip an inactive student going
  forward — a withdrawn/on-leave student stops being swept into new
  semesters' course plans or new course assignments, at the one shared
  choke point every auto-enroll caller (registration, class transfer,
  bulk import, new assignment, Open Semester, Bulk Assign, Workload
  Import) already goes through. The Students table gained a Status
  column (Active/Inactive badge) and filter, alongside the existing Class
  filter.
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
  `notifyResultsPublished`/`notifyLeaveNotice` (the passive hooks) each
  wrap their entire body in try/catch and swallow every error — a missing
  phone number, the feature being off, or a DB hiccup all just silently
  no-op. This is what makes the hook safe to `await` directly inside a
  core Server Action (publish, leave-notice create) without any extra
  try/catch at the call site: publishing results, for example, always
  succeeds regardless of whether WhatsApp is enabled, configured, or
  working. Enqueueing itself (one Prisma insert per row) is fast enough
  to just await rather than defer — the real "fire-and-forget" boundary
  is the SEND, which happens later, out-of-process, on the worker's own
  poll cycle. `sendTimetableNotifications` (the timetable one — MANUAL
  now, see the "Trigger points" bullet) and `sendManualNotification` are
  called from Server Actions the caller is waiting on, so they RETURN an
  enqueued/skipped count (still never throw per recipient) rather than
  being pure fire-and-forget. **`LECTURER_LOGIN_CREDENTIALS` and
  `TIMETABLE_READY` don't enqueue at ALL** — they build a `wa.me`
  manual-share link the admin opens themselves
  (`buildLecturerCredentialsShareUrl` / `buildTimetableReadyShareUrl`);
  the worker never sees them. See the "Lecturer login credentials" and
  "Timetable Ready" bullets below.
- **Sending (VPS side, `whatsapp-service/`) is a separate deployable**
  with its own `package.json` — plain `pg` (not Prisma), so it never
  needs to track the main app's schema.prisma or run `prisma generate`.
  It polls `whatsapp_notification_logs` for `PENDING` rows (batches of
  10, oldest first), sends each via Baileys, and writes back
  `SENT`/`FAILED` + the error. **The queue is drained at a controlled ONE
  MESSAGE PER 5 SECONDS** (`INTER_MESSAGE_DELAY_MS`, default 5000, env-
  overridable) — never a burst — which matters most for the manual "Send
  timetable notifications" action that can enqueue hundreds of rows in
  one click. A `batchInFlight` flag makes only one poll batch run at a
  time (the `setInterval` fires every 5s but a tick that lands mid-batch
  just returns), so overlapping ticks can't re-fetch the same PENDING
  rows and send them in parallel — without it the 5s pacing would be
  defeated and rows could double-send. See `whatsapp-service/README.md`
  for VPS setup, session persistence, and re-scanning the QR code.
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
- **Trigger points** — two passive hooks (each a thin call at the end of
  an existing Server Action, never new business logic of its own) plus
  ONE manual, explicit-click sender:
  - `publishAssessment` (lecturer) -> `notifyResultsPublished` -> every
    student with a newly-PUBLISHED result on that assessment.
  - `createDailyLogEntry`, only when `type === "LEAVE_NOTICE"` ->
    `notifyLeaveNotice` -> whichever single party the entry names
    (`relatedLecturerId` or `relatedStudentId` — identical handling
    either way, same pattern the daily-log action itself already uses).
    NOTE/PROBLEM entries never notify.
  - **Timetable notifications are MANUAL and per-batch, NOT an automatic
    per-edit hook** (see the "Manual, per-batch, rate-limited timetable
    notifications" roadmap entry). `createTimetableSlot`/
    `updateTimetableSlot`/`deleteTimetableSlot`/`clearClassTimetable`/
    `confirmAutoTimetableBatch`/`clearSemesterLevelTimetable` enqueue
    NOTHING — a drag-and-drop session, a single-slot form edit, an
    auto-generate confirm, a clear: none of them message anyone. Instead
    an admin/dean clicks **"Send timetable notifications"** once the
    timetable is in its final shape, from either of two places:
    - **Per semester-number batch** — a persistent card on Workload
      Import & Auto-Timetable (`/admin/workload-import`,
      `/dean/workload-import`), sibling to "Clear timetable for a
      semester level", gated on `timetable.generate`. Pick a
      `Class.currentSemesterNumber` level -> a preview dialog (student/
      lecturer counts, per-class breakdown, "already sent at [time]"
      warning) -> `sendTimetableBatchNotifications(semesterNumber, force?)`
      resolves every ACTIVE student in every class at that level that has
      a built timetable in the active semester, PLUS every lecturer with
      a `TimetableSlot` in that batch (dean-scoped via `classDeanWhere`),
      and hands them to `sendTimetableNotifications`.
    - **Per class** — a "Send notifications" button next to "Clear
      timetable" on the Timetable Builder
      (`build-timetable-client.tsx`), gated on `timetable.manage`,
      scoped to the currently-picked class + semester
      (`sendClassTimetableNotifications(classId, semesterId, force?)`).
    Both funnel into `lib/whatsapp-notify.ts`'s `sendTimetableNotifications`
    — fills the shared `TIMETABLE_CHANGE` template once (both
    `{studentName}` and the newly-added `{recipientName}` placeholder
    hold the recipient's own name, since the audience is now mixed
    student/lecturer), enqueues one `WhatsAppNotificationLog` row per
    recipient (`entity: "Class"`, `entityId: classId`), returns
    `{enqueuedStudents, enqueuedLecturers, skipped}`. The worker then
    paces the actual sends at one message / 5s. Recipient resolution
    lives in ONE place, `admin/timetable/queries.ts`'s
    `resolveTimetableNotificationRecipients(classes, semesterId)`, reused
    by both actions (the caller passes an already-dean-scoped class
    list). Audited as `TIMETABLE_NOTIFICATIONS_SENT` (one entry per
    click, `scope: "batch" | "class"`, counts, `resent` flag).
  - **Duplicate-send guard**: `getRecentTimetableSend(classIds)`
    (`lib/whatsapp-notify.ts`) returns the most recent `TIMETABLE_CHANGE`
    log row for those classes within 24h + how many are still `PENDING`.
    The preview surfaces it as an amber "already queued at [time] ([N]
    still sending) — resend anyway?" banner and flips the button to
    "Resend anyway"; the send action ALSO re-checks server-side and
    throws `RECENTLY_SENT` (mapped to a clear message in
    `lib/action-error.ts`) if a send happened within
    `TIMETABLE_RESEND_GUARD_MS` (10 min) unless `force: true` — belt-and-
    braces against a stale preview / rapid double-click.
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
  message text for each notification event type.
- **Message templates / extensible event types** (`WhatsAppMessageTemplate`
  — see the "Custom notification event types + manual send" section below
  for the full current-state design; the paragraph immediately below
  covers only what didn't change from the original built-in-3-triggers
  version) hold the `templateText` sent for each event, with
  `{placeholder}` tokens filled in per recipient — e.g. `{studentName}`,
  `{mark}`, `{changeSummary}`. The 3 original triggers
  (RESULTS_PUBLISHED/LEAVE_NOTICE/TIMETABLE_CHANGE) are still seeded with
  the EXACT text each hardcoded before this table existed, so nothing
  about an outgoing message changed when this table (or later, its
  extensibility) was added, until an admin deliberately edits one.
  `updateWhatsAppTemplate` (`admin/whatsapp/actions.ts`) rejects a save
  containing any `{placeholder}` outside the known set for that row's
  OWN triggerKind/eventKey (real typo protection, e.g. `{studnetName}`,
  or a placeholder that's valid for a different event), audited as
  `WHATSAPP_TEMPLATE_UPDATED` with old/new text; "Reset to default"
  (`resetWhatsAppTemplate`, AUTOMATIC only — see below) restores the
  registry's coded default and audits `WHATSAPP_TEMPLATE_RESET` the same
  way. `lib/whatsapp-notify.ts`'s three AUTOMATIC notify functions fetch
  the effective template via `getEffectiveAutomaticTemplate` — a 60s
  in-memory cache (same shape as `lib/permission-cache.ts`, explicitly
  invalidated right after a save/reset/create/deactivate/reactivate) so a
  fan-out (e.g. one call per student on a class-wide timetable change)
  hits the DB once, not once per recipient — then fill it with
  `fillTemplate`. **Fallback safety**: `getEffectiveAutomaticTemplate`
  only ever returns a DB-stored template if it's non-blank AND uses only
  known placeholders for that event; anything else (missing row, empty
  string, a placeholder that somehow became invalid, e.g. edited directly
  in the DB) falls back to the seeded default rather than risk a
  broken/literal `{typo}` reaching an outgoing message — a MANUAL
  template has no such default to fall back to, see below. The Templates
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

### Custom notification event types + manual send

Event types are no longer a fixed 3-entry enum, and notifications are no
longer only ever automatic. Two kinds, per `WhatsAppMessageTemplate.
triggerKind`:

- **AUTOMATIC** — tied to a code hook. `lib/whatsapp-templates.ts`'s
  `AUTOMATIC_EVENTS` is the ONE place these hooks are enumerated (key,
  label, description, placeholder list, default text) — currently six:
  `RESULTS_PUBLISHED` and `LEAVE_NOTICE` (passive hooks),
  `TIMETABLE_CHANGE` (still uses the Baileys worker; sent only by the
  explicit "Send timetable notifications" button — per-batch or per-class
  — not automatically on slot edits; its placeholder set gained
  `{recipientName}` alongside the original `{studentName}` since the
  audience is now mixed student/lecturer), `TIMETABLE_READY`,
  `LECTURER_LOGIN_CREDENTIALS`, and `CLASS_TIMETABLE_GROUP_SHARE` (all
  three **delivered by a `wa.me` MANUAL SHARE LINK, NOT the worker** — the
  admin opens WhatsApp and hits Send themselves; see the three bullets
  below). `TIMETABLE_READY` placeholders: `{semesterName}`,
  `{academicYear}`, `{domainName}`, `{facultyName}`, deliberately NO
  username/password. `CLASS_TIMETABLE_GROUP_SHARE` placeholders:
  `{className}`, `{semesterName}`, `{academicYear}`, `{domainName}` — NO
  phone/username/faculty, since it's a group broadcast the admin forwards
  themselves.
  "AUTOMATIC" here means "its placeholder set and default text live in
  code" (not "sent by the worker" — three of the six now bypass it) —
  which is what lets `LECTURER_LOGIN_CREDENTIALS` carry its own
  credential-specific tokens (`{academicYear}`, `{semesterName}`,
  `{domainName}`, `{username}`, `{tempPassword}`, `{facultyName}`); a
  MANUAL row is locked to the one shared `MANUAL_TEMPLATE_PLACEHOLDERS`
  set and could not. **A new automatic type can only be
  created for a hook that ALREADY EXISTS in this registry** — creating
  one from the admin UI never makes a new automatic trigger fire on its
  own; a genuinely new automatic event always starts with a real code
  change (a new `lib/whatsapp-notify.ts` notify function + a new
  `AUTOMATIC_EVENTS` entry), and only THEN can an admin register its
  template row. The "Create new event type" dialog's AUTOMATIC picker
  only ever offers registry keys that don't already have a row (today:
  none, since all 6 are seeded) — enforced again server-side in
  `createWhatsAppTemplate`, never trusted from the client. All 6
  are `isSystem = true`: never deletable, fully editable
  (templateText, via the same `updateWhatsAppTemplate`/
  `resetWhatsAppTemplate` as before), exactly as before this feature.
- **Timetable Ready** (`TIMETABLE_READY`, AUTOMATIC, seeded `isSystem` by
  migration `20260902120000_timetable_ready` with the exact Somali text —
  byte-identical to `TIMETABLE_READY_DEFAULT` in
  `lib/whatsapp-templates.ts` so "Reset to default" agrees): a
  LECTURER-ONLY "your timetable for {semesterName} {academicYear} is
  ready, view it at {domainName}" message — carries NO login credentials.
  **Delivered by a `wa.me` MANUAL SHARE LINK, not the Baileys worker**
  (see the "wa.me manual share" change below): clicking "Share via
  WhatsApp" opens WhatsApp (app or Web) with the filled message
  pre-composed in a chat with that lecturer's number; the admin hits Send
  themselves — this app transmits nothing on its own for this message
  type, and no `WhatsAppNotificationLog` row is created. **COMPLETELY
  INDEPENDENT of `LECTURER_LOGIN_CREDENTIALS`**: different template,
  different button, a different tracking field
  (`LecturerTimetableNotification.linkOpenedAt`, a per-(lecturer,
  semester) row) that `User.credentialsLinkOpenedAt`/
  `User.pendingCredential` never touch and vice versa. **Students get
  nothing here.** Lives as a `SendTimetableReadyCard` on **Workload
  Import & Auto-Timetable** (`/admin/workload-import`,
  `/dean/workload-import`), alongside the "Send timetable notifications"
  and "Clear timetable" batch cards — the one place "a semester batch" is
  a first-class concept (`Class.currentSemesterNumber` level picker).
  Gated on `timetable.generate` (no new permission). Pick a semester
  level → `previewSendTimetableReady(level)` lists every lecturer with a
  built timetable at that level in the active semester (dean-scoped via
  `resolveAffectedBatchClasses` → `resolveAffectedBatchLecturers` in
  `admin/auto-timetable/actions.ts`; list membership IS the scope check)
  with per-lecturer status "Link opened {date}" vs "Share via WhatsApp".
  **There is NO bulk send** — the bulk case is this per-lecturer list of
  "Share via WhatsApp" buttons the admin clicks through one at a time
  (each needs its own wa.me link opened); each row marks itself "Link
  opened" and the header shows an "N of M opened" progress line.
  `shareTimetableReady(lecturerId, level, force?)` builds the wa.me URL
  via `buildTimetableReadyShareUrl`, returns it for the client to open in
  a new tab (the tab is opened synchronously on click, then redirected,
  to dodge popup blockers), upserts `LecturerTimetableNotification`
  (`linkOpenedAt`/`openedById`), and audits
  `LECTURER_TIMETABLE_READY_LINK_OPENED` per lecturer (`semesterId` +
  `reopened` flag). A repeat share is soft-blocked (`ALREADY_OPENED`)
  unless `force` (the "Share again" button) — always allowed, since it's
  admin-initiated, not automatic spam. `{facultyName}` resolves from
  `Lecturer.departmentId`, else a class they teach in the batch, else
  blank; `{domainName}` from `WhatsAppSettings.domainName` — refused
  (`DOMAIN_NOT_CONFIGURED`) until set. NOT gated by the WhatsApp on/off
  toggle (a manual link doesn't use the worker).
- **Lecturer login credentials** (`LECTURER_LOGIN_CREDENTIALS`,
  AUTOMATIC, seeded `isSystem` by migration
  `20260831120000_lecturer_credentials_send` with the exact Somali
  message text — byte-identical to `LECTURER_LOGIN_CREDENTIALS_DEFAULT`
  in `lib/whatsapp-templates.ts` so "Reset to default" agrees):
  **delivered by a `wa.me` MANUAL SHARE LINK, not the Baileys worker**
  (see the "wa.me manual share" change below) — a SEPARATE, explicit
  "Share via WhatsApp" click, never automatic on account generation.
  Reachable from the post-generation results dialog / "Reset password"
  dialog (per-lecturer buttons — this list IS the bulk case, one wa.me
  link per row, no single bulk action) AND — the persistent entry point
  — a per-row "Share via WhatsApp" action on the main Lecturer Accounts
  table itself. `shareLecturerCredentials` (`admin/lecturer-accounts/
  actions.ts`, gated on `user.manage`; there is NO `...Batch`) fills the
  template with the lecturer's real `username`, the temp password from
  EITHER the client (the still-open results dialog, in memory) OR the
  decrypted `User.pendingCredential` — the latter is what lets the table
  re-share the SAME still-valid credential anytime without a
  `resetLecturerPassword`. Plus their faculty (`Lecturer.departmentId`,
  else a class they teach, else blank), the active `AcademicYear.name` +
  `Semester.name`, and `WhatsAppSettings.domainName` — then
  `buildLecturerCredentialsShareUrl` returns the `wa.me` URL the client
  opens in a new tab (opened synchronously on click, then redirected, to
  dodge popup blockers). NO `WhatsAppNotificationLog` row is created.
  A table share with no client-supplied password AND no decryptable
  stored credential fails `NO_STORED_CREDENTIAL` / shows "Reset password
  to share".
  **Configured domain**: `WhatsAppSettings.domainName` (nullable, set on
  `/admin/whatsapp` via `setWhatsAppDomain`, `whatsapp.manage`) is the
  `{domainName}` shown to every lecturer; sharing is refused
  (`DOMAIN_NOT_CONFIGURED`) until it's set. **Link-opened tracking**:
  `User.credentialsLinkOpenedAt` (renamed from `passwordSentAt`) is
  stamped when the wa.me link is OPENED — NOT a delivery confirmation
  (the admin still hits Send inside WhatsApp themselves) — and cleared on
  every `resetLecturerPassword` (a fresh temp password is un-shared
  again). `User.pendingCredential` (the encrypted stored copy) is
  written by generate/`resetLecturerPassword` and wiped by the lecturer's
  own `changePassword` and by the Users-page `resetUserPassword`. Once
  `credentialsLinkOpenedAt` is set, "Share via WhatsApp" is soft-blocked
  (`ALREADY_OPENED`) with a "Share again" override (`force: true`, behind
  a confirm). Once the lecturer has logged in and changed the password
  (`mustChangePw === false`) it's HARD-blocked (`PASSWORD_CHANGED`) —
  `force` does NOT override that. Audited per lecturer as
  `LECTURER_CREDENTIALS_LINK_OPENED` (who, lecturer, when, `reopened`
  flag), never one batch entry. NOT gated by the WhatsApp on/off toggle
  (a manual link doesn't use the worker). Not offered on the generic
  Send Notification compose form — that path is strictly `triggerKind ===
  "MANUAL"`.
- **Class Timetable — Group Share** (`CLASS_TIMETABLE_GROUP_SHARE`,
  AUTOMATIC, seeded `isSystem` by migration
  `20260903120000_class_timetable_share` with the exact Somali text —
  byte-identical to `CLASS_TIMETABLE_GROUP_SHARE_DEFAULT` in
  `lib/whatsapp-templates.ts`): a per-class **"Share to WhatsApp Group"**
  button on the Timetable Builder (next to "Send notifications" /
  "Clear timetable", gated on `timetable.manage`, dean-scoped via
  `classDeanWhere`), for classes that already coordinate via a student
  WhatsApp group. `buildClassTimetableGroupShareUrl` fills the template
  with `formatClassLabel(class)`, the semester name + academic year, and
  `WhatsAppSettings.domainName`, then `buildWaMeShareUrl` returns a
  **PHONE-NUMBER-LESS** `https://wa.me/?text=<message>` URL — opening it
  launches WhatsApp's **own chat/GROUP picker** so the admin/dean forwards
  it to that class's group and hits Send themselves. **The app never
  learns which group, sends nothing, enqueues no `WhatsAppNotificationLog`
  row, and does NOT touch the Baileys worker.** Refused
  (`DOMAIN_NOT_CONFIGURED`) until the domain is set; NOT gated by the
  WhatsApp on/off toggle. Tracked ONLY by a `ClassTimetableShare` row per
  `(class, semester)` — `sharedAt` / `sharedById` (no FK; the audit is
  authoritative) — which drives the same "already shared … Share again"
  soft-block (`ALREADY_SHARED`, cleared by `force`, guard window
  `TIMETABLE_RESEND_GUARD_MS` = 10 min) as credentials/timetable-ready.
  Audited per share as `CLASS_TIMETABLE_GROUP_SHARED` (class, semester,
  `reshared` flag). **COMPLETELY SEPARATE** from the per-lecturer
  `TIMETABLE_READY` share (different template, different table, `{className}`
  not `{facultyName}`, no phone) AND from students' in-app bell
  notifications — an additional, optional, manual channel. **Students
  still get ZERO automated WhatsApp** — this is a link the admin forwards
  by hand.
- **MANUAL** — no code hook; created by an admin with a free-typed name
  (e.g. "University Holiday", "Assignment Reminder") — `eventKey` is
  slugified from that name (`slugifyEventKey`, e.g. "University Holiday"
  -> `UNIVERSITY_HOLIDAY`) and immutable after creation, rejected if it
  collides with an existing template's key OR a built-in AUTOMATIC key.
  Every MANUAL template shares ONE fixed placeholder set —
  `MANUAL_TEMPLATE_PLACEHOLDERS` in `lib/whatsapp-templates.ts`:
  `{recipientName}`, `{senderName}`, `{className}`, `{facultyName}`,
  `{date}`, and `{message}` — never a per-template custom list.
  `{message}` is the one placeholder the SENDER fills in at send time (a
  free-text box on the Send Notification compose form, shown only when
  the picked template actually uses `{message}`); every other one is
  auto-filled per recipient/scope, always present as `""` when not
  applicable (e.g. `{facultyName}` is blank for an individual-recipient
  send) so a sent message never shows a literal leftover `{token}`.
  MANUAL templates are `isSystem = false` and soft-deactivatable
  (`deactivateWhatsAppTemplate`/`reactivateWhatsAppTemplate`, `deletedAt`
  — same convention as Room/Campus/Shift's own deactivate/reactivate,
  never a hard delete) — a deactivated template disappears from the Send
  Notification picker and from "Create new event type"'s reuse, but its
  past deliveries stay in the delivery log untouched (no FK from
  `WhatsAppNotificationLog`, which stores its own `eventKey` string
  snapshot either way). `resetWhatsAppTemplate` refuses a MANUAL row —
  there's no coded default to restore.
- **Send Notification** (`admin/notifications/send/`, one shared panel
  rendered at THREE routes — `/admin/notifications/send`,
  `/dean/notifications/send`, `/lecturer/notifications/send` — same "one
  implementation, multiple routes" pattern as Daily Log/Timetable/
  Workload Import): pick a MANUAL template -> pick recipient(s) ->
  preview the filled-in message -> "Send Notification" -> a confirm
  dialog showing the live-resolved recipient count -> "Confirm & Send"
  enqueues via `lib/whatsapp-notify.ts`'s `sendManualNotification`
  (the same `enqueue` helper and phone-number/enabled-toggle rules every
  AUTOMATIC trigger already uses — fully respected, never bypassed).
  Gated on a new permission, `notification.send.manual` — held by ADMIN,
  DEAN, AND LECTURER by default (never STUDENT), independent of
  `notification.templates.manage` (which stays ADMIN-only: anyone with
  send access can USE a template, only ADMIN can CREATE/EDIT one).
  - **WHERE-scoping is a THIRD tier, re-derived from the caller's ROLE
    every call** (`admin/notifications/send/recipients.ts`'s
    `resolveSenderScope` — same `getUserAccess(userId).roleNames`-based
    idiom as Daily Log/Timetable, DEAN taking precedence over LECTURER
    over the ADMIN default for a multi-role user, matching
    `app-shell.tsx`'s nav-href precedence exactly): **ADMIN** —
    unrestricted, any student/lecturer/class/faculty. **DEAN** —
    faculty-scoped via `dean_departments`/`lib/dean-scope.ts`, reusing
    `classDeanWhere`/`studentDeanWhere` (individual student, whole class)
    and `lecturerDeanWhere` (individual lecturer — "currently teaching
    in-scope", same candidate pool as Ownership Transfer's picker); a
    picked faculty for the "whole faculty" scope must be one of the
    dean's own `dean_departments` entries (checked, `FORBIDDEN`
    otherwise). **LECTURER** — scoped to their OWN
    `LecturerCourseAssignment` rows only: "individual student" is scoped
    to students enrolled (ACTIVE) in any of the lecturer's own
    assignments (matched by the same courseId+classId+semesterId tuple
    `getMyTimetableForStudent`/lecturer reports already use — there's no
    direct enrollment-to-assignment relation in the schema); "class"
    scope is really "my course" — picking one of the lecturer's own
    assignments, recipients = students ACTIVE-enrolled in that exact
    course+class+semester, never the whole class's roster if the class
    has other courses too. A lecturer can NEVER pick recipientKind
    LECTURER (no lecturer-to-lecturer manual notify) and NEVER "whole
    faculty" scope — both rejected server-side (`FORBIDDEN`) even if
    somehow requested, not just hidden in the UI. Recipients are ALWAYS
    re-resolved server-side from `(recipientKind, scope, targetId)` plus
    the caller's own tier — never trusted from a client-supplied
    recipient list, same "ownership-check-IS-the-query" idiom as
    `requireAssignmentOwner`/the rest of this app's dean-scoped features.
    `resolveManualRecipients` is the ONE place this resolution happens,
    used identically by both the live preview action
    (`previewManualNotificationRecipients`) and the real send
    (`sendManualNotification`), so a sender can never see a preview the
    send itself would resolve differently. Verified directly against a
    real Prisma 6.19 query that `OR: []` (used when a lecturer has zero
    course assignments) matches zero rows, never "no filter at all" — an
    empty tuple/department list is always a safe, explicit zero-result
    guard, never a silent widen to "everyone."
  - **Faculty-wide LECTURER broadcasts use `Lecturer.departmentId`** (the
    lecturer's registered home faculty — a plain profile field, see the
    "Lecturer registration split" business rule), NOT `lecturerDeanWhere`
    — deliberately a different lookup than the individual-lecturer picker
    above: "every lecturer IN this faculty" is a distinct, equally valid
    question from "lecturers currently teaching in-scope," and
    `Lecturer.departmentId` is the exact field Lecturer Accounts' own
    "generate accounts by department" bulk action already established
    for this "by home faculty" grouping.
  - Audited as ONE `WHATSAPP_MANUAL_SENT` entry per send (template name/
    key, recipientKind, scope, recipientCount, enqueued/skipped counts) —
    matching the established one-entry-per-batch-operation convention
    (BULK_ASSIGNED, WORKLOAD_IMPORTED, …), never one row per recipient
    (the per-recipient record already lives in
    `WhatsAppNotificationLog`).

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
  (`admin/auto-timetable/`, entered either from Step 1's own success
  dialog — passing exactly the just-created assignments — or, for
  assignments created in an earlier session, from the persistent
  "Generate timetable" card described in the "Persistent re-entry point"
  changelog entry below, which re-queries whatever's still unscheduled).
  **Eligibility rule**: which `Class.currentSemesterNumber` LEVELS (the
  batch's cohort level, 1..8 — a completely different number from
  `Semester.semesterNumber`, see the "Add/Edit Semester" bullet above;
  never conflate them) can be generated THIS CYCLE depends on which real
  academic-calendar Semester is currently `is_active`: active Semester 1
  -> only ODD class levels (1,3,5,7) are eligible; active Semester 2 ->
  only EVEN ones (2,4,6,8) — this mirrors how the whole institution
  actually advances together (the Open Semester wizard bumps every
  advancing class's level in lockstep with opening a real Semester), so
  it is a single institution-wide fact, resolved ONCE
  (`getActiveAcademicSemesterNumber`, `admin/workload-import/
  generator-data.ts`) and applied uniformly — never hardcoded to
  "odd-only" or re-derived per assignment. Within the eligible set,
  processing is still one level at a time in ascending order (e.g. under
  an active Semester 2: 2, then 4, then 6, then 8). Assignments for a
  level of the WRONG parity are never silently dropped — both the
  generator and the pending card report them explicitly (see
  `lib/auto-timetable.ts`'s `describeIneligibleLevels`, e.g. "These
  assignments are for odd-level classes, which are scheduled during
  Semester 1 — they'll become available for generation once Semester 1
  is active again"), left for manual scheduling until their cycle comes
  around. If there's no active Semester, or its `semesterNumber` hasn't
  been set (a nullable legacy field), eligibility genuinely can't be
  determined — every level is reported ineligible with that specific
  reason instead of guessing. Flow: opening the generator lands on the
  FIRST eligible level found → the generator reads each class's room
  directly off `Class.roomId` (room is a class-registration property —
  see the "Class Timetable" business rule's "room is a class-registration
  property" bullet below — never picked here; a class with no room set is
  reported upfront with a direct link to set one and its assignments are
  excluded from this batch's scheduling, never guessed) →
  **Generate preview** (`previewAutoTimetableBatch`, a pure read, NO
  writes) → a results screen with three clearly separated sections → an
  explicit **Confirm this semester** button → ONLY on that click does
  `confirmAutoTimetableBatch` write `TimetableSlot` rows for that level's
  classes, in one transaction → the UI then offers "Generate semester
  [next eligible level]" as a separate explicit action — it never
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
  - **Pre-generation feasibility validation** — BEFORE the algorithm ever
    runs for a level, `checkBatchFeasibility` (`lib/auto-timetable.ts`,
    pure/DB-free, run entirely client-side against data already loaded —
    no extra round trip) compares, per lecturer, their TOTAL available
    teaching time (the union of every distinct (day, shift) slot usable
    by at least one of their own assignments in this batch — every valid
    class day × shift if unrestricted, narrowed by their own
    LecturerAvailability rules otherwise) against their TOTAL required
    session time (the REAL scheduled duration per assignment — an
    explicit shift override's own total, or `findClosestShiftCombo`'s
    `totalHours`, never the raw requested `creditHours` figure, which can
    legitimately differ once rounded to whole shifts). A lecturer whose
    required hours exceed their available hours is infeasible by
    construction — no rearrangement of days/shifts could ever fit it,
    with or without backtracking. Surfaced as a new wizard step,
    **Feasibility check** (`feasibility-warning-step.tsx`), shown after
    "Lecturer availability" (if that ran) but before the preview: lists
    every infeasible lecturer with the exact math
    (`formatFeasibilityMessage`, e.g. "Lecturer X needs 15h of sessions
    but their availability only allows 9h (Sat: 3 shifts = 4.5h, Tue: 3
    shifts = 4.5h). Reduce their workload, add more available days/
    shifts, or reassign some courses to another lecturer before
    generating."). Advisory, not a hard block — "Continue anyway" proceeds
    to the preview regardless (generation will simply leave some of that
    lecturer's sessions Unscheduled, which is still fine); "Edit lecturer
    availability" jumps straight back to that step. Skipped entirely (falls
    straight through to Generate preview) when every lecturer in the batch
    is feasible. Per-level bypass state (`feasibilityBypassedKeys`, mirrors
    `availabilityConfirmedKeys`) is cleared automatically whenever
    availability is edited for that level again, so a just-changed number
    always gets a fresh check rather than trusting a stale "continue
    anyway."
  - **Backtracking search (Phase 2 of `generateTimetableForBatch`)** — the
    two-pass greedy placement described above (Pass 1/Pass 2) is Phase 1;
    anything it still can't place is retried in a bounded backtracking
    repair before landing in Unscheduled. For each unresolved session,
    `tryResolve` (`lib/auto-timetable.ts`) first searches for a genuinely
    free slot again (something else placed earlier in this same repair
    pass may have freed one up), then — up to `maxDisplacementDepth`
    (default 2) — tries DISPLACING exactly one already-placed session that
    is the SOLE blocker of a candidate slot, recursively finding that
    displaced session its own new home via the identical search, chaining
    up to the depth limit. Every attempted placement, original or
    displaced, still goes through the exact same
    `findTimetableConflicts`/`isShiftAllowedForLecturerOnDay`/period/day
    checks as Phase 1 — backtracking only searches harder for a VALID
    placement, it never relaxes a hard rule. Only sessions placed earlier
    in THIS batch are eligible to be displaced (`ConflictCandidateSlot.id`
    starting with `"batch:"`) — a pre-existing DB row
    (`existingCandidates`) is never moved. A displaced session can never be
    "relocated" right back into the exact slot being freed for the session
    that bumped it — every recursive call carries the growing set of
    slots already claimed by an ancestor in its chain (`reservedSlots`)
    and skips them, which is what stops a degenerate chain from silently
    double-booking a room (a real bug caught and fixed during this
    feature's own review, before it ever shipped — see
    `lib/auto-timetable.test.ts`'s dedicated regression test). Bounded by
    a wall-clock time budget (`timeBudgetMs`, default 8000ms) checked
    throughout the search — once exceeded, whatever's left simply stays
    Unscheduled with its usual specific reason, exactly as if backtracking
    had never run; a secondary, timing-independent attempt ceiling
    (`DEFAULT_MAX_ATTEMPTS = 5000`) bounds worst-case cost regardless of
    how generous the time budget is. A session actually rescued by
    backtracking (or displaced to make room for one) is always reported in
    `scheduledWithFallback` with its own `fallbackNotes` entry — never
    silently folded into `scheduledNormally` — so it stays visible for
    review the same way the Pass-2 spacing fallback already was.
    `GenerationResult` gained `backtrackingStats`
    (`attempted`/`resolved`/`timedOut`/`elapsedMs`), surfaced in the
    generator UI as a small "Backtracking search placed N of M session(s)
    that a simple pass would have left Unscheduled…" note whenever it ran.
    The preview-loading spinner's copy was updated to "Searching for the
    best schedule… this may take a few seconds" to set expectations
    (`previewAutoTimetableBatch` is one synchronous server round trip —
    there is no incremental/streaming progress to show mid-search).
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
  - **PDF/Excel export of the multi-class preview — color-coded by
    course, before Build**: "Export Excel" and "Export PDF" buttons on
    the multi-class overview (`admin/auto-timetable/multi-class-
    overview.tsx`, next to "Build all") export the CURRENT preview
    state — every class in this semesterNumber batch, including any
    manual drag/edit adjustments already made in the overview or a
    class's fullscreen review, never the raw un-edited algorithm output
    once something's been changed. Built via
    `admin/auto-timetable/preview-export.ts`, whose own doc comment is
    the authoritative "why" — the short version: this data is the
    admin/dean's in-memory preview state, which doesn't exist server-side
    at all until "Build all," so both exports run ENTIRELY client-side
    (no Server Action, no base64 round trip through `lib/download.ts`'s
    `downloadBase64` the way every other export in this app works) —
    `ExcelJS`/`jsPDF`/`jspdf-autotable` are dynamically `import()`ed only
    when a button is actually clicked, so neither library bloats the
    page's initial client bundle.
    - **Color-by-course** (`lib/course-colors.ts`, pure/DB-free,
      independently unit-tested): every SESSION of a given COURSE —
      never lecturer, never class — gets the identical color, everywhere
      that course appears across every class in the export. Colors are
      assigned once per export, from the full set of course NAMES
      present (not courseId — see the module's own doc comment for why:
      every layer of this client-side preview pipeline, from
      `ScheduledSession` on down, already only ever carries a course's
      name, never its id, so name is the only identity available without
      a much larger, purely-cosmetic pipeline change; the one known
      consequence is this app's pre-existing genuine duplicate `Course`
      rows sharing a name would also share a color here, a cosmetic
      coincidence since nothing here writes data), in a stable
      alphabetical order so the same course set always reproduces the
      same colors. The base 8 hues are the `dataviz` skill's validated
      reference categorical palette (`references/palette.md`'s
      CVD-safe, fixed-order light-surface hexes). Beyond 8 courses —
      routine for a real semester, where a course can't be generically
      folded into "Other" the way a chart's 9th legend series can — this
      is a disclosed, deliberate departure from that skill's "never
      cycle past 8" rule: colors cycle back through the SAME 8 hue
      families at a lightened, then a darkened, tint (8 × 3 = 24 distinct
      colors) rather than inventing new, unvalidated hues, and every
      colored cell ALSO carries the course name as a visible text label
      — exactly the "secondary encoding" that same rule already treats
      as the legal mitigation for going beyond a color-alone identity
      channel. `pickTextColor` (WCAG relative-luminance contrast, same
      module) chooses black or white text per generated fill so every
      cell stays readable regardless of how light or dark its color is.
    - **Excel** (`buildPreviewWorkbook`/`downloadPreviewExcel`, via
      `exceljs` — NOT the `xlsx` package every other export in this app
      already uses, whose free/community build has no cell-fill-color
      write support at all; every existing `xlsx` export is untouched,
      since none of them color cells): a "Legend" sheet first (course
      name -> color swatch, alphabetical), then one sheet per class —
      sheet names sanitized/truncated to Excel's 31-char, no-`\/?*[]:`,
      no-duplicate rules with a numbered-suffix dedupe. Each class sheet
      is laid out exactly like its on-screen mini-card/fullscreen grid:
      row 1 = day headers, one row per Shift, each session cell filled
      with its course's color and showing course name + lecturer
      (multiple sessions in one cell join on separate lines; an open
      cell gets no fill). A flagged (spacing-fallback) or
      crossPeriodOverride session gets a plain-text marker appended in
      the cell (a static document can't show the on-screen hover/badge
      treatment).
    - **PDF** (`buildPreviewPdf`/`downloadPreviewPdf`, via `jsPDF` +
      `jspdf-autotable`, landscape A4): the document's own first page is
      the color legend (swatch + course name, wrapped into columns), then
      one page per class via `autoTable` — same Shift-rows x Day-columns
      layout and same per-cell fill/text-marker rules as the Excel sheet,
      built from the identical `PreviewExportData` shape so the two
      exports can never disagree with each other or with the on-screen
      preview.
    - Both builders share the exact same `sessionsForCell` (which row a
      session's time falls into — the same heuristic
      `components/timetable/schedule-grid.tsx`'s `ScheduleGrid` already
      uses for on-screen rendering, duplicated here as a small standalone
      pure function rather than importing from that "use client"
      component file) and `cellText`/`rowLabel`/`dayHeaders` helpers, so
      the grid layout an admin sees in either export always matches what
      the other one — and the live overview — shows.
    - Not wired into the already-built/confirmed Timetable views (the
      manual drag-and-drop Builder, the "Now" view's own Excel export,
      Dean/Lecturer reports) — `assignCourseColors` is a generic, pure
      function of a course-name list with no dependency on the preview
      pipeline, so any of those COULD reuse it for the same course-color
      consistency, but doing so was explicitly scoped out as a
      nice-to-have, not required, for this feature; see the "PDF/Excel
      preview export" changelog entry below.

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
  bigger default), Classes (Academic Structure > Classes tab —
  filters: free-text search on name/batchCode/section, Program
  (`SearchableSelect`), Mode (FT/PT), Period (Morning/Afternoon),
  Semester (1..8 = `currentSemesterNumber`), Status (active/inactive =
  `deletedAt`); the panel additionally fetches the FULL unfiltered class
  list as `allClasses` for the "Bulk update period" dialog's own
  client-side filtering, and resolves the `editClassId` deep-link target
  via a direct `findUnique` since it may be filtered out / off-page). `useUrlTableState.setFilter(key, "")` DELETES that
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
  Programs, Semesters, Academic Years, Course Plans, Transfer
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
    `LECTURER_ACCOUNT_GENERATED`/`LECTURER_PASSWORD_RESET`. A SEPARATE,
    explicit "Send credentials" (per lecturer, and "Send all" / "Send to
    all eligible" for a batch) — reachable BOTH from the post-generation
    results dialog AND persistently from the main Lecturer Accounts table
    — WhatsApps the temp password via the `LECTURER_LOGIN_CREDENTIALS`
    template; never automatic on generation. The table entry point
    re-sends the SAME still-valid credential from the encrypted-at-rest
    `User.pendingCredential` (no reset needed). A sent password is
    flagged (`User.passwordSentAt`) so it can't be re-sent by accident
    (soft-blocked with a "Resend anyway" override, hard-blocked once the
    lecturer has changed it). See the WhatsApp Notifications section's
    "Lecturer login credentials" bullet.
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

Extension — Delete an unused lecturer registration (branch `main`): the
  Lecturer Registration table (`admin/lecturers/`) gained a per-row Delete
  action (`deleteLecturer`, `user.manage`, trash icon + `window.confirm`,
  same destructive-confirm pattern as `deleteTimetableSlot`). `Lecturer`
  has no `deletedAt` column (unlike almost every other reference entity in
  this app) — this is a genuine hard delete, deliberately narrow: blocked
  with `HAS_ACCOUNT` if the lecturer already has a login account (deleting
  the profile would strand that `User` row as a dead-end ghost account,
  the same scenario `createUser` already refuses to create) and with
  `HAS_ASSIGNMENTS` if they have any `LecturerCourseAssignment` (which has
  no `onDelete` cascade on `lecturerId` — the DB would reject it anyway;
  checked here first for a specific error instead of a raw FK violation).
  Meant for correcting a registration mistake right after entry, not as an
  offboarding tool — an active lecturer is deactivated via Users instead.
  Audited as `LECTURER_DELETED` with staffNo/fullName. New tests in
  `admin/lecturers/actions.test.ts` (permission gate, both guards, the
  happy-path delete+audit). Full suite: 625 passing.

Bug fix — Decimal serialization crash on the Timetable page (and a
  codebase-wide audit for the same class of bug): a live error, "Only
  plain objects can be passed to Client Components from Server
  Components. Decimal objects are not supported," crashed
  `admin/timetable/panel.tsx` at `<TimetableClient {...data} />`. Root
  cause: `LecturerCourseAssignment.creditHours` (a nullable `Decimal`,
  added during the workload-import phase) is a genuine scalar column, so
  Prisma's default `include: { ... }` behavior pulls it in on EVERY
  `lecturerCourseAssignment` query regardless of which relations are
  named — several call sites fetched it this way and then passed the raw
  row straight to a Client Component prop or returned it from a Server
  Action, both of which reject a non-plain `Decimal` instance. This
  codebase already had an established, if informal, convention for this
  exact problem — every OTHER Decimal field (`Assessment.maximumMarks`,
  `AssessmentResult.mark`) is converted with a bare `Number(...)` at the
  query site before ever reaching a client boundary — `creditHours` was
  simply added later and missed it. Fix: a new small shared helper,
  `lib/serialize.ts`'s `nullableDecimalToNumber(value)` (null-safe, since
  `creditHours` is nullable unlike the other two fields), applied via
  `.map(...)` immediately after every Prisma fetch whose result crosses a
  Server-to-Client boundary carrying a raw `LecturerCourseAssignment` (or
  anything nesting one) — not a fetch-time `select`/transform in Prisma
  itself, since several of these call sites still need the rest of the
  row's fields untouched. Every corresponding manually-declared client-
  side type (`AssignmentRow`, etc.) was updated from the Prisma-generated
  `creditHours: Decimal | null` to `Omit<LecturerCourseAssignment,
  "creditHours"> & { creditHours: number | null }` — types that were
  already inferred via `Awaited<ReturnType<typeof someQuery>>` needed no
  change, since the fix at the query site propagates automatically.
  Fixed sites, found via a full-codebase audit of every
  `lecturerCourseAssignment.findMany/findFirst/findUnique` call (not just
  the one reported screen, per the explicit request): `admin/timetable/
  queries.ts` (`getTimetableSlots` — the exact crash site — and
  `getAssignmentOptions`), `admin/assignments/panel.tsx` +
  `assignments-client.tsx`'s `AssignmentRow` type, `dean/transfers/
  panel.tsx` + `transfers-client.tsx`'s `AssignmentRow` type, `dean/
  reports/panel.tsx` + `reports-client.tsx`'s `AssignmentRow` type,
  `dean/reports/queries.ts`'s `getCourseReport` (its `assignment` field
  crosses to the client via the `fetchCourseReport`/`exportCourseReport`
  Server Actions), and `lecturer/reports/queries.ts`'s
  `getClassResultReport` (same pattern, via `lecturer/reports/
  actions.ts`). Audited and confirmed SAFE, no fix needed: `lib/auth.ts`,
  `lib/enrollment.ts`, `admin/semesters/panel.tsx`, every
  `lecturerCourseAssignment` read inside `admin/workload-import/*` and
  `admin/auto-timetable/actions.ts` (creditHours is either never returned
  to the client or already explicitly `Number(...)`-converted before
  crossing), `dean/reports/queries.ts`'s `getClassReport` (already builds
  a plain object excluding creditHours), and `student/queries.ts`'s
  `getStudentCourseDetail` (the raw assignment is used only to read
  `.id` server-side, never returned). The single-slot
  `createTimetableSlot`/`updateTimetableSlot`/`deleteTimetableSlot`
  actions were checked too — they return the plain `TimetableSlot` row
  itself (no `include`, no `creditHours` column on that model), so
  needed no change. Separately re-verified the other three Decimal
  fields (`maximumMarks`, `mark`, `ResultCorrection.oldMark`/`newMark`)
  are still converted everywhere they cross a client boundary — all
  already were; `ResultCorrection` itself is write-only (created but
  never read back/displayed anywhere), so its Decimal columns were never
  at risk. New `lib/serialize.test.ts` pins the null-safety and,
  specifically, that fractional precision survives the conversion (2.5
  in, 2.5 out — not 2 or 2.50000001, the exact concern raised with this
  fix). Full suite: 629 passing.

Extension — Persistent re-entry point for auto-timetable generation
  (branch `main`): the workload-import success dialog's "Continue to
  auto-generate timetable" button only ever appears immediately after a
  fresh Excel confirm — `createdAssignments` is local client state, not
  persisted, so the button is gone after a page reload, a closed tab, or
  simply navigating away before clicking it. `admin/workload-import/
  actions.ts` gained `getPendingAutoTimetableAssignments(userId)`: every
  `LecturerCourseAssignment` with `creditHours` set (the workload-import
  eligibility marker) and zero `TimetableSlot` rows yet
  (`timetableSlots: { none: {} }`), dean-scoped via the same
  `assignmentDeanWhere` idiom as every other dean-scoped query in this
  module — built into the exact same `CreatedAssignmentSummary` shape the
  success dialog already produces, so it feeds the identical
  `AutoTimetableGeneratorClient` with no new prop shape or behavior
  differences. Surfaced as a new `PendingAutoGenerateCard`
  (`admin/workload-import/pending-auto-generate-card.tsx`), rendered by
  `WorkloadImportPanel` above the existing Tabs (so it's visible
  regardless of which import tab is active, and survives tab-switching
  since it holds its own `generating` state) whenever `timetable.generate`
  is held and at least one such assignment exists — "N assignment(s) not
  yet scheduled, across semester level(s) X, Y — Generate timetable".
  Clicking it opens the SAME sequential generator flow as the success
  dialog, byte-for-byte (the eligibility rule this counts/highlights
  against was odd-only at the time this card was built; see the "Fix —
  eligibility now follows the active academic semester's parity" entry
  below for the correction). `confirmAutoTimetableBatch`
  (`admin/auto-timetable/actions.ts`) gained a `revalidatePath("/dean/
  workload-import")` alongside its pre-existing `/admin/workload-import`
  call, so the pending count refreshes on both routes after confirming —
  it was previously only revalidating the admin path. New tests in
  `admin/workload-import/actions.test.ts` (query shape — creditHours set
  + zero slots, dean scoping, the CreatedAssignmentSummary field mapping,
  null classRoomLabel when the class has no room). Full suite: 633
  passing.

Fix — eligibility now follows the active academic semester's parity, not a
  hardcoded "odd only" (branch `main`): the auto-timetable generator's
  ordering rule was too rigid — it always started from the lowest ODD
  `Class.currentSemesterNumber` present, unconditionally, which silently
  blocked a legitimate case: when the active academic-calendar Semester is
  actually Semester 2 (even-level classes are what's mid-cycle), the
  odd-only rule offered nothing to generate at all for those classes. See
  the "Workload Excel import + auto-timetable generation" business rule's
  Step 2 bullet above for the corrected description — this entry is the
  changelog.
  - `lib/auto-timetable.ts`: `sequentialOddSemesterNumbers` (hardcoded
    odd-only) replaced by `parityForAcademicSemesterNumber(activeAcademic
    SemesterNumber)` (academic Semester 1 -> `"ODD"`, 2 -> `"EVEN"`, null
    when there's no active Semester or its `semesterNumber` hasn't been
    set) and `classifySemesterNumbersByEligibility(classSemesterNumbers,
    activeAcademicSemesterNumber)`, which returns BOTH the ascending
    `eligible` levels (what used to be the whole result) AND the ascending
    `ineligible` ones — present but the wrong parity right now, never
    silently dropped. `describeIneligibleLevels(ineligibleLevels,
    activeAcademicSemesterNumber)` builds the one shared explanation
    string both the generator and the pending card show (e.g. "These
    assignments are for odd-level classes, which are scheduled during
    Semester 1 — they'll become available for generation once Semester 1
    is active again"; a distinct message when parity can't be determined
    at all).
  - A new `getActiveAcademicSemesterNumber()` (`admin/workload-import/
    generator-data.ts`) resolves the ONE currently-`isActive` Semester's
    own `semesterNumber` field once per page load (not per
    assignment/group — this is a single institution-wide fact, since the
    Open Semester wizard always advances every class in lockstep with
    opening a real Semester) and is threaded down as a new
    `activeAcademicSemesterNumber` prop through `WorkloadImportPanel` ->
    `WorkloadImportTabsClient` -> all three import tabs' own "Continue to
    auto-generate timetable" flow AND the persistent `PendingAutoGenerate
    Card` -> `AutoTimetableGeneratorClient` — every entry point into the
    generator now agrees on the same eligibility fact, computed once.
  - `AutoTimetableGeneratorClient`'s internal `buildGroups` now calls
    `classifySemesterNumbersByEligibility` instead of the old odd-only
    function; its `SemesterGroup.evenLevelAssignments` field (always
    "even", by the old hardcoded assumption) became the generic
    `ineligibleLevels`/`ineligibleAssignments`, shown via
    `describeIneligibleLevels` both in the per-group informational banner
    (shown once, at the start of the flow) and in the "nothing eligible at
    all" fallback screen — which previously always said "No classes at an
    odd semester level were found," a misleading message in the Semester-
    2-active case since it implied nothing existed at all rather than
    "these exist, but not yet."
  - `PendingAutoGenerateCard` (the persistent re-entry point added in the
    previous phase) now splits `pendingAssignments` into eligible/
    ineligible via the same shared classifier before rendering: the
    headline "N assignment(s) not yet scheduled" count and levels list
    only ever include ELIGIBLE ones (fixing a real overcount — it
    previously showed every pending assignment's level regardless of
    whether it could actually be generated right now), and a separate
    amber note reports the ineligible ones with the identical
    `describeIneligibleLevels` explanation the generator itself shows —
    never silently absorbed into the headline count, never silently
    hidden. The "Generate timetable" button only appears when there's at
    least one eligible assignment; the informational note appears
    independently whenever any ineligible ones exist, even if the
    eligible count is zero.
  - No server-side change to `previewAutoTimetableBatch`/
    `confirmAutoTimetableBatch` (`admin/auto-timetable/actions.ts`) — same
    as before this fix, they schedule whatever `semesterNumber` they're
    asked for with no parity check of their own; eligibility was always a
    client-side WORKFLOW restriction (which levels the generator UI
    offers), not a security/academic-integrity boundary, and the
    drag-and-drop Build Timetable/manual Add Assignment remain the
    unrestricted fallback for any level regardless of the active
    semester's parity — unchanged by this fix, per the feature's original
    "never weakens or bypasses" requirement.
  - New tests: `lib/auto-timetable.test.ts` replaced its
    `sequentialOddSemesterNumbers` suite with
    `parityForAcademicSemesterNumber`/`classifySemesterNumbersByEligibility`/
    `describeIneligibleLevels` coverage (both parities, null-parity
    fallback, nulls in the input ignored either way). New
    `admin/workload-import/generator-data.test.ts` (didn't exist before
    this fix) covers `getActiveAcademicSemesterNumber`'s three cases (a
    real number, no active semester, an active semester with no number
    set — all correctly `null` except the first). Full suite: 645
    passing.
  - Not yet visually verified end-to-end in a browser — same
    `next/navigation`-requires-a-real-authenticated-request constraint
    noted on every other post-Phase-7 UI addition in this log.

Bug fix — auto-generate algorithm only tried ONE (shift, day) slot per
  session instead of the full cross-product, plus a grouped/session-
  labeled results redesign (branch `main`): a live run against real
  pending workload-import assignments showed EVERY session across EVERY
  class failing with the byte-for-byte identical reason ("No valid
  day/shift remains for Subax 3aad (11:00-12:30)").
  - **Root cause** (`lib/auto-timetable.ts`'s `generateTimetableForBatch`):
    `findClosestShiftCombo(creditHours, shiftsForMode)` picks ONE preferred
    shift (or small multiset of shifts) per session purely from the
    credit-hour target — a pure function with no awareness of scheduling
    conflicts. The OLD placement loop then only ever tried THAT preferred
    shift's own time across every valid day (`for (const shift of
    sessionShifts) { for (const day of validDays) { ...check conflicts...
    } }`) — it never tried a DIFFERENT shift template if the preferred
    one's capacity in that class's room was exhausted. Many classes
    commonly share a small pool of rooms, and many courses commonly land
    on the same "closest" shift for a common credit-hour value (e.g. every
    1-credit-hour course picks the same 1h shift) — so once that ONE
    (room, shift) pair's 5 valid FT days were used up by the first 5
    classes needing it, every subsequent class needing the identical
    shift failed identically, even though completely different shift
    templates in the very same room were sitting empty the whole time.
    Confirmed directly against the real dev DB with a throwaway read-only
    script reproducing the exact reported batch (20 pending assignments,
    5 classes × 8 sessions, all funneled onto one "Subax 3aad" shift by
    the closest-combo picker): the OLD algorithm produced 0 scheduled, 40
    unscheduled, ALL with the identical reason text — an exact match for
    the bug report.
  - **Fix**: placement now tries the FULL (shift × day) cross-product
    before giving up. A new `orderShiftsByPreference(preferred,
    shiftsForMode)` puts the credit-hour combo's preferred shift first
    (unchanged behavior when it's actually available) followed by every
    OTHER shift for the study mode; a new `findFirstOpenSlot(shiftOrder,
    validDays, usedDaysForAssignment, onlyUnusedDays, baseInput,
    candidates)` searches shift-then-day within that order. The existing
    two-pass spacing rule is preserved exactly, just widened: **Pass
    1** — every shift (preferred first) × only days NOT yet used by this
    assignment; **Pass 2** — only reached if pass 1 placed nothing
    anywhere — every shift × every valid day, including reused ones (this
    also fixes a latent secondary bug: pass 2 previously re-tried the
    SAME single shift/time on an already-used day, which is a guaranteed
    self-conflict by construction, making the old pass 2 a no-op in
    practice; trying a genuinely DIFFERENT shift on that day, as CLAUDE.md
    always said pass 2 should, now actually happens). Re-ran the same
    real-data script against the fixed algorithm: 40 scheduled normally,
    0 fallback, 0 unscheduled — every session placed, several correctly
    overflowing onto a different shift than the one originally preferred.
  - **Deliberate exception — explicit shift overrides stay strict**: an
    admin's per-assignment shift override (`shiftOverrideIds`, the
    generator's optional "shift override" control) is NOT subject to this
    fallback — it represents a deliberate, explicit choice, so silently
    substituting a different shift when the override is fully booked
    would contradict what was asked for. An overridden assignment that
    can't be placed at its exact chosen shift still lands in Unscheduled,
    with a reason naming the override specifically.
  - **No change to the hard conflict rules or the spacing rule's
    semantics** — same `findTimetableConflicts` function, same
    unused-days-first priority, same never-force-place guarantee. Only
    which (shift, day) PAIRS get attempted before giving up changed.
  - `ScheduledSession`/`UnscheduledItem` both gained `sessionNumber`/
    `sessionCount` (1-based position among an assignment's own sessions,
    and the total) — the data-side half of the UI fix below, and also
    what makes "session 2 of 2 unscheduled while session 1 of 2 scheduled"
    representable at all. `UnscheduledItem` also gained `classId` (it only
    had the display `className` string before), needed to group results
    by class reliably rather than by a possibly-non-unique name.
  - **Results UI redesign** (`admin/auto-timetable/
    auto-timetable-generator-client.tsx`): the flat, three-separate-tables
    layout (one row per session, course+lecturer repeated verbatim on
    every row with no indication two rows were the same course's two
    sessions) is replaced by a new pure grouping module,
    `lib/auto-timetable-results.ts`'s `groupGenerationResult`, and a
    genuinely restructured view:
    - A total summary bar at the very top of the whole report: "Scheduled
      normally (X) · Scheduled with spacing fallback (Y) · Unscheduled
      (Z)" across every class in the batch.
    - One collapsible `<details>` section PER CLASS (native, no new
      dependency), its `<summary>` showing the class name plus its own
      Normal/Fallback/Unscheduled count badges (zero-count badges hidden).
    - Inside each class, the SAME three sections again, scoped to that
      class: "Scheduled normally (X)", "Scheduled with spacing fallback
      (Y)", "Unscheduled (Z)" — never a flat repeated list.
    - Within "Scheduled normally"/"...fallback", sessions are grouped by
      their course+lecturer (one `LecturerCourseAssignment`); a
      multi-session assignment shows "Session 1 of 2" / "Session 2 of 2"
      labels instead of two visually-identical lines — the label is
      omitted entirely when `sessionCount === 1`, since there's nothing to
      disambiguate.
    - "Unscheduled" is grouped by REASON TEXT instead (per class, via
      `UnscheduledReasonGroup`) — the exact "deduplicated where the same
      reason applies to a clear group" fix: the explanation sentence is
      shown ONCE, followed by a compact list of every affected
      "CourseName — Lecturer (Session i of N)" underneath it, sorted
      most-affected-reason-first, instead of repeating the full sentence
      once per session.
  - New tests: `lib/auto-timetable.test.ts` — replaced the old
    single-shift hard-conflict test (which encoded the OLD buggy
    assumption that a fully-booked preferred shift meant nothing could be
    scheduled) with one proving the fix finds a DIFFERENT open shift, plus
    a new genuinely-exhaustive-conflict test (every shift blocked on every
    day) confirming Unscheduled still works when there's truly nothing
    left to try; a dedicated many-classes-one-room reproduction of the
    exact reported bug shape (6 classes sharing a room, same preferred
    shift — old behavior would strand the 6th, the fix schedules all 6);
    an explicit-override-never-falls-back test; a
    sessionNumber/sessionCount labeling test. New
    `lib/auto-timetable-results.test.ts` (11 cases — grouping by class
    then course/lecturer, session ordering, fallback note text, per-class
    and overall totals across multiple classes, reason deduplication and
    most-affected-first ordering, per-class reason scoping, an assignment
    split across both a scheduled and an unscheduled session appearing
    correctly in both places, the empty-result case). Full suite: 660
    passing.
  - Verified directly against the real dev DB with a temporary, read-only
    diagnostic script (not committed — deleted after use): reproduced the
    exact reported batch (20 pending assignments across 5 classes,
    Semester 1 active -> level 3 eligible) and confirmed OLD=0
    scheduled/40 unscheduled (identical reason, matching the bug report
    verbatim) vs. NEW=40 scheduled/0 unscheduled, with the grouped-results
    shape showing 8 sessions correctly attributed to each of the 5
    classes.

Business rule change — Period (Morning/Afternoon) dimension for FT classes
  and shifts, fixing cross-period auto-generate spillover (branch `main`):
  see the "Class Timetable" business rule's "Period (Morning/Afternoon) —
  FT-only" bullet above for the current-state description; this entry is
  the changelog.
  - **Schema**: new `Period` enum (`MORNING`/`AFTERNOON`), nullable
    `period` column added to both `Class` and `Shift` (migration
    `20260806155730_ft_period`, additive only — no backfill, per explicit
    instruction not to guess). PT rows keep `period = null` forever
    (app-enforced in `composeClassData`/the new `composeShiftData`, not a
    DB constraint) and are completely unaffected by every change below.
  - **Forms**: `admin/classes/schema.ts`/`classes-client.tsx` and
    `admin/timetable/shifts/schema.ts`/`shifts-client.tsx` each gained a
    Period picker that only renders (and is required, via a Zod `.refine`)
    when `studyMode === "FT"`; switching study mode away from FT clears
    any picked period via a `useEffect`, mirroring the existing
    Day-dropdown-narrows-on-assignment-change pattern. Both tables gained
    a Period column ("Not set" flagged in amber for an FT row still
    missing one). `Class.period` is NOT inherited at promotion — a new
    class row (the existing per-semester-level naming model) always
    starts with an explicit, un-prefilled Period pick.
  - **Algorithm fix** (`lib/auto-timetable.ts`): `generateTimetableForBatch`
    now filters `shiftsForMode` to `shift.period === assignment.period`
    whenever the assignment's `studyMode === "FT"`, computed once per
    assignment before shift-combo picking, override resolution, AND the
    day×shift placement search — so every downstream step (preferred-shift
    combo, `shiftOverrideIds` lookup, the pass-1/pass-2 spacing-fallback
    search) automatically respects the restriction with no separate check
    needed. PT assignments skip the filter entirely — `shiftsForMode` is
    used unfiltered, byte-for-byte the pre-existing behavior. This is the
    direct fix for the reported bug: generation was spilling a
    Morning-period class's overflow session onto a Galab (Afternoon)
    shift once every Subax shift/day combination for that room was
    booked out; now that session correctly lands in Unscheduled instead
    of crossing periods.
  - **Reporting, never guessing**: `previewAutoTimetableBatch`
    (`admin/auto-timetable/actions.ts`) gained a `classesWithoutPeriod`
    check (same shape and "report + exclude from scheduling" treatment as
    the pre-existing `classesWithoutRoom`) for an FT class with no period
    set yet; PT classes never appear here. `CreatedAssignmentSummary`
    (`admin/workload-import/actions.ts`) and `WorkloadImportRow`
    (`admin/workload-import/schema.ts`) both gained a `classPeriod` field,
    threaded through all three workload-import variants (bulk, by-class,
    by-semester) and `getPendingAutoTimetableAssignments`, so the
    generator client (`auto-timetable-generator-client.tsx`) can block
    generating for an unset-period FT class BEFORE even calling Generate
    preview — same UX as the room check — and, critically, so its
    shift-override picker filters to the assignment's own class period
    too (never offering a wrong-period override shift to pick in the
    first place, which would otherwise have been silently dropped from
    the schedule with no session created — an override id the algorithm's
    own period filter excludes from `shiftsForMode` simply fails to
    resolve).
  - **Migration data — reported, not guessed** (per explicit instruction):
    querying the live dev DB before this shipped found 9 existing FT
    classes (CEN26-CEN-FT, CMS26-CMS-4A/4B/4C/4D/4E-FT, CMS26-CMS-A-FT,
    CMS26-CMS-B-FT, ML26-CMS-A-FT) and 6 existing FT shifts (Subax
    1aad/2aad/3aad, Galab 1aad/2aad/3aad) all with `period = null` —
    none were auto-assigned; the app owner was asked to assign each one's
    period manually via the Classes/Shifts edit forms (the shift names
    already encode Subax=Morning/Galab=Afternoon, but this was reported
    for confirmation rather than silently inferred from the name).
  - Tests: `lib/auto-timetable.test.ts` gained a `period restriction
    (FT-only)` describe block (Morning-only-uses-Morning,
    Afternoon-only-uses-Afternoon, never-spills-to-the-other-period-even-
    when-fully-booked reproducing the reported bug, a many-classes
    -sharing-a-room case proving the BUG-1 cross-shift overflow fix still
    respects the period boundary, PT-completely-unaffected,
    no-period-set-yet-reports-the-standard-no-templates-reason); all
    pre-existing `ShiftTemplate`/`AssignmentToSchedule` fixtures updated
    with an explicit `period` field. `admin/classes/actions.test.ts` and
    `admin/timetable/shifts/actions.test.ts` gained
    required-for-FT/forced-null-for-PT coverage.
    `admin/auto-timetable/actions.test.ts` gained `classesWithoutPeriod`
    coverage (FT-with-no-period reported and excluded, PT never flagged,
    an FT assignment's shift search restricted to its class's own
    period). Full suite passing.
  - Not yet visually verified end-to-end in a browser — same
    `next/navigation`-requires-a-real-authenticated-request constraint
    noted on every other post-Phase-7 UI addition in this log; `tsc
    --noEmit`, ESLint, and the full Vitest suite were run clean.

Bug fix — Period filtering was missing from the MANUAL Timetable Builder
  (branch `main`): when Period was added, `lib/auto-timetable.ts`'s
  auto-generate algorithm was correctly restricted, but the manual tools
  — the drag-and-drop weekly builder (`build-timetable-client.tsx`) and
  the single-slot Add/Edit dialog (`timetable-client.tsx`) — have their
  OWN separate client-side shift-fetching/filtering logic (both derive
  `shiftsForClass` from the shared `shifts` prop themselves, never
  routing through `lib/auto-timetable.ts`) and had NOT been updated —
  both still filtered by `studyMode` alone, so an FT class's manual
  builder/picker showed every FT shift across BOTH periods. Confirmed via
  direct code inspection before fixing (not assumed): this was a real
  gap, not already-correct duplicate coverage.
  - `build-timetable-client.tsx`: `shiftsForClass` (the grid's ROWS) now
    additionally filters to `shift.period === selectedClass.period`
    whenever the class's studyMode is FT — a Morning-period class's grid
    only ever shows Subax rows, Afternoon only Galab; PT is untouched (no
    period filter applied at all, same as `lib/auto-timetable.ts`). A new
    `periodOk` gate (`studyMode !== "FT" || !!selectedClass.period`)
    blocks the course-chip list and grid from rendering at all for an FT
    class with no period set yet — same amber-block-with-a-link-to-
    Classes pattern already used for "no room assigned"/"no study mode
    set", not a variant treatment. The per-session room-override
    affordance on a placed card needed no change — it only ever offers a
    different ROOM, never a different shift/time via a picker (dropping a
    card onto a different grid row is how its shift/time changes, and
    every row is already period-filtered by construction); the free-typed
    inline time edit is unrelated to shift selection and was already
    unconstrained before Period existed.
  - `timetable-client.tsx` (single-slot dialog): the "Use a shift"
    picker's `shiftsForClass` gained the identical FT-period filter.
    Unlike the weekly builder, this dialog does NOT block opening/
    submitting for a period-less FT class — a shift pick has always been
    an optional convenience here (start/end time stays freely editable
    regardless), so the fix is scoped to the picker itself: its
    `emptyMessage` and a new inline amber note (shown only when the
    selected assignment's class is FT with no period) explain why the
    list is empty, with the same link to that class's edit page, without
    adding a new hard requirement beyond what already existed.
  - No server-side/query change was needed — `getAssignmentOptions`/
    `getClassOptions` (`admin/timetable/queries.ts`) already return the
    full `Class`/`Shift` rows (no restrictive `select`), so `period` was
    already present on both `assignments[].class.period` and
    `shifts[].period` once the Prisma client was regenerated for the
    Period migration; only the two client components' own filter
    predicates were missing the extra condition.
  - No new test file — this codebase has no client-component (`.tsx`)
    unit tests anywhere (confirmed via a repo-wide search before
    concluding this); `lib/auto-timetable.ts`'s own period-restriction
    tests (added when Period shipped) are unaffected and still cover the
    algorithm itself, which was already correct. `tsc --noEmit`, ESLint,
    and the full Vitest suite (674 passing, unchanged) were run clean —
    this fix touches no server-side logic Vitest exercises.
  - Not yet visually verified end-to-end in a browser — same
    `next/navigation`-requires-a-real-authenticated-request constraint
    noted throughout this log.

New feature — Bulk update period for classes (branch `main`): see the
  "Class Timetable" business rule's "Bulk update period" bullet above for
  the current-state description; this entry is the changelog.
  - New `app/(app)/admin/classes/bulk-period-dialog.tsx` (`BulkPeriodDialog`)
    rendered from `classes-client.tsx` via a new "Bulk update period"
    button next to "Add class" — a two-step dialog (select -> confirm),
    matching the Checkbox-list-with-select-all pattern already used by
    Transfer Students, not a new UI idiom. No new query was needed to
    build the selection list: `ClassesPanel` already fetches every Class
    unfiltered for the main table, so the dialog just filters that
    existing prop client-side (`studyMode === "FT" && !deletedAt`, then
    the Program/Semester filters) — no server round trip until "Continue".
  - Two new Server Actions in `admin/classes/actions.ts`, both gated on
    `structure.manage` (no new permission key — this is plain Class
    management, same as `createClass`/`updateClass`):
    `previewBulkClassPeriodUpdate(classIds)` (read-only — resolves each
    id's current `period` AND whether it has any `TimetableSlot` yet, via
    `assignment.classId` — `TimetableSlot` has no direct `classId` column,
    only through its `LecturerCourseAssignment`) and
    `bulkUpdateClassPeriod({classIds, newPeriod})` (writes). Both
    re-verify `studyMode: "FT"` server-side independently — a non-FT id
    (the picker only ever offers FT, but this is the standard
    never-trust-the-client defense every bulk action in this app applies)
    is silently excluded, never an error, and `bulkUpdateClassPeriod`
    reports the excluded count as `skipped` rather than force-updating or
    silently miscounting. The write itself is a single `class.updateMany`
    — no `$transaction`/loop needed, since every selected row gets the
    identical new value with no per-row branching.
  - The "existing timetable" warning is informational only, exactly as
    requested — a class with `hasExistingSlots: true` is still fully
    included in the update; the dialog surfaces it, the server doesn't
    block on it. Changing `Class.period` was already decoupled from
    `TimetableSlot` before this feature (nothing in the schema links
    them), so this is a pure read-side check, not a new constraint.
  - Audited as `CLASS_PERIOD_BULK_UPDATED`: `oldValue.classes` (id/name/
    period as they were) and `newValue` (the new period + id/name per
    class) in one entry per bulk operation — matching the established
    one-summary-entry-per-batch-operation convention (BULK_ASSIGNED,
    WORKLOAD_IMPORTED, TIMETABLE_ROOMS_BULK_CREATED), not one row per
    class.
  - Tests: `admin/classes/actions.test.ts` gained both actions' coverage
    (permission gates, empty-input short-circuit, the
    current-period/hasExistingSlots preview shape, the FT-only re-check
    on both preview and confirm with the `skipped` count, the
    reject-when-nothing-eligible case, and the exact audit payload shape).
    No new client-component test — this codebase has no `.tsx` unit tests
    anywhere (same as every other client-only fix in this log). `tsc
    --noEmit`, ESLint, and the full Vitest suite (683 passing) were run
    clean.
  - Not yet visually verified end-to-end in a browser — same
    `next/navigation`-requires-a-real-authenticated-request constraint
    noted throughout this log.

Redesign — Auto-generate preview is a multi-class overview with per-class
  fullscreen drag-and-drop review (branch `main`): the auto-timetable
  generator's results screen (previously a flat, one-level-at-a-time
  stepper ending in the "grouped, session-labeled results view" text
  list) is replaced by a genuine multi-class GRID overview, reusing the
  drag-and-drop weekly grid throughout rather than building three
  separate implementations.
  - **`components/timetable/schedule-grid.tsx`** (new) — the
    Shift-rows x Day-columns grid + drag-and-drop wiring extracted out of
    `build-timetable-client.tsx` into one shared, presentation-only
    component (`ScheduleGrid`), parameterized by `scale` ("full" |
    "compact") and `interactive` (boolean). It has no idea whether a drop
    writes to the DB or to local React state — callers supply plain
    `rows`/`sessions`/`chips` data and callbacks. `build-timetable-client.tsx`
    (the manual Timetable Builder) was refactored to render `ScheduleGrid`
    at full/interactive scale wired to the existing
    `createTimetableSlot`/`updateTimetableSlot`/`deleteTimetableSlot`/
    `getClassScheduleSlots` Server Actions — byte-for-byte the same
    behavior as before (optimistic updates, busy/error-flash states, room
    override, inline time/room edit), just reshaped through the shared
    component instead of its own bespoke DnD internals.
  - **`lib/auto-timetable-preview-state.ts`** (new, pure/DB-free, unit
    tested) — the local-editing model for the overview: `PreviewSession`/
    `PreviewChip`/`ClassPreviewState` plus `buildPreviewStateByClass`
    (reshapes a fresh `GenerationResult` into one editable state per
    class) and `scheduleChipInClass`/`moveSessionInClass`/
    `editSessionTimeInClass`/`editSessionRoomInClass`/
    `unscheduleSessionInClass` (each re-validates via the EXISTING
    `findTimetableConflicts` pure function — no new conflict algorithm —
    against both the class's own other sessions and every other class's
    currently-placed sessions in the same batch, so a manual edit can
    never silently introduce a room/lecturer/class clash). Nothing here
    writes to the DB; `flattenSessionsForCommit` is the only bridge back
    to `confirmAutoTimetableBatch`'s real `sessions` shape.
  - **`admin/auto-timetable/multi-class-overview.tsx`** (new) — shows
    EVERY class in the currently-selected semester-level batch at once,
    as a responsive card grid (1 column mobile, 2 at `md`, 3 at `xl`).
    Owns the editable `Map<classId, ClassPreviewState>` for the whole
    batch (seeded once from the server preview via
    `buildPreviewStateByClass`); a top summary bar totals
    scheduled/flagged/unscheduled across every class plus the "Build all"
    button, which flattens the CURRENT state (including any per-class
    fullscreen edits) and hands it to the caller — nothing is written
    until that click, same "confirm this semester" gate as before.
  - **`admin/auto-timetable/class-mini-card.tsx`** (new) — one card per
    class: name, a compact scheduled/flagged/unscheduled badge summary,
    and a MINI `ScheduleGrid` (`scale="compact"`, `interactive={false}`)
    — the exact same component the fullscreen modal uses, just smaller
    and read-only, so a spacing-fallback session renders with the
    identical amber-flag treatment at both scales. An expand icon in the
    card's top-right corner is the only way to edit that class.
  - **`admin/auto-timetable/class-fullscreen-modal.tsx`** (new) — a
    full-viewport (`fixed inset-0`) overlay rendering `ScheduleGrid` at
    full interactive scale, seeded with that ONE class's local preview
    state: drag a course chip from the unscheduled tray onto an open
    cell to schedule it, drag a placed session to move it, drop it on the
    trash zone to unschedule it, click a placed session's time/room to
    edit it inline — all backed by the pure preview-state functions above
    (never a Server Action). A rejected drop flashes the target cell red
    with a toast naming the conflict, mirroring the manual builder's own
    optimistic-with-revert convention, just synchronous/local instead of
    server-round-tripped. Closing the modal hands the final
    `ClassPreviewState` back to the overview, which folds it into the
    batch-wide map — this is what makes "closing fullscreen preserves the
    adjustments back in the overview" true with no extra plumbing.
  - **`admin/auto-timetable/auto-timetable-generator-client.tsx`**
    (rewritten) — the old forced one-level-at-a-time stepper
    (`groupIdx`/`levelIdx`, "next level only offered after this one is
    confirmed") is replaced by a free "Semester filter" `Select` at the
    top, flattened across every real Semester group into one list of
    (semester, level) options — picking one immediately fetches a preview
    for THAT level (an effect keyed on the selection, no separate
    "Generate preview" click needed) and renders `MultiClassOverview`.
    Room/period-missing-class banners, the ineligible-levels banner, and
    the "Assignments in this batch" table (with its per-assignment shift-
    override +/- control and manual "Regenerate preview" button for after
    tweaking one) are all unchanged in behavior, just re-scoped to
    whichever level the filter currently points at instead of a fixed
    step. A level already confirmed this session shows a simple "already
    confirmed" card instead of a stale/re-runnable grid — re-previewing a
    confirmed level would try to reschedule assignments that already have
    real `TimetableSlot` rows (their own just-written slots would show up
    as self-conflicts), so this is a deliberate guard, not a missing
    feature. `MultiClassOverview` is remounted (via a
    `${levelKey}:${previewVersion}` key) only on a genuinely fresh preview
    (initial load or "Regenerate preview"), never on confirm, so a build
    doesn't discard the just-committed view.
  - **Room reference data reintroduced for the generator**: the
    generator now also needs a room LIST (not just `Class.roomId`) for
    the fullscreen modal's per-session room-override control, mirroring
    the manual builder's own "different room for this session" escape
    hatch. `admin/timetable/queries.ts`'s `getRoomOptions` was exported
    (previously module-private) and reused — not duplicated — by a new
    `getRoomOptionsForGenerator` in `admin/workload-import/
    generator-data.ts`, fetched in `panel.tsx` alongside the existing
    shift list and threaded through the same prop chain
    (`WorkloadImportTabsClient` -> the three import-tab clients ->
    `PendingAutoGenerateCard` -> `AutoTimetableGeneratorClient`).
  - **`CreatedAssignmentSummary` gained `lecturerId`** (alongside the
    pre-existing `lecturerName`) — needed so the overview's local
    conflict checks can actually detect a lecturer double-booking client-
    side; both construction sites (`getPendingAutoTimetableAssignments`
    and `finalizeWorkloadImport`) already had the value on hand (the raw
    Prisma row's `lecturerId` scalar, and `WorkloadImportRow.lecturerId`
    respectively), so this was a pure additive field, no new query.
  - **`lib/auto-timetable-results.ts` removed** (with its test file) —
    the old flat/collapsible "grouped, session-labeled results view" it
    powered is gone now that the overview itself IS the per-class,
    per-course breakdown; nothing else in the codebase referenced it, so
    it was deleted rather than left as dead code.
  - Tests: `lib/auto-timetable-preview-state.test.ts` (new, 16 cases —
    building state from a GenerationResult across multiple classes,
    scheduling a chip successfully/rejected (own-class and
    cross-class/external conflicts), moving a session (including flagged
    clearing on a successful move), time/room edits (no-op short-circuit,
    valid edit, rejected clash), unscheduling back to a chip, counts,
    flattening for commit, and the other-classes-vs-own-class candidate
    split). `admin/workload-import/generator-data.test.ts` gained
    `getRoomOptionsForGenerator` coverage. `admin/workload-import/
    actions.test.ts` updated for the new `lecturerId` field on
    `CreatedAssignmentSummary` (both the `getPendingAutoTimetableAssignments`
    exact-shape `toEqual` and the `confirmWorkloadImport` created-row
    assertion). No new `.tsx` unit tests — this codebase still has none
    (same as every other client-only UI change in this log). `tsc
    --noEmit`, ESLint, and the full Vitest suite (689 passing) were all
    run clean.
  - Verified the affected routes still compile and serve under the
    existing dev server (`/admin/workload-import`, `/admin/timetable`,
    `/admin/auto-timetable` all returned a clean 307 auth redirect, no
    500/compile error in the server log) — full drag-and-drop interaction
    was NOT visually verified end-to-end in a browser, same
    `next/navigation`-requires-a-real-authenticated-request constraint
    noted throughout this log; see the chat response for the manual
    testing plan handed to the user.

New feature — "Clear timetable" at the class and semester-level batch
  (branch `main`): a previously generated or manually built timetable can
  now be wiped before re-importing/re-generating, without touching the
  underlying workload data. Two independent actions, both delete-only —
  neither ever touches `LecturerCourseAssignment`/`creditHours` (the
  workload-import data), which is exactly what lets
  `getPendingAutoTimetableAssignments` (its `timetableSlots: { none: {} }`
  filter) pick the now-unscheduled assignments straight back up as "not
  yet scheduled," with zero re-import needed.
  - **Per-class** — `clearClassTimetable(classId, semesterId)`
    (`admin/timetable/actions.ts`, `timetable.manage`, same permission
    every other single-slot CRUD action in that file already uses):
    deletes every `TimetableSlot` for one class in one semester, scoped
    exactly like the existing `getClassScheduleSlots` (class lookup
    through `classDeanWhere` when the caller is a Dean). A new "Clear
    timetable" button on the Timetable Builder
    (`build-timetable-client.tsx`), next to the class/semester pickers,
    appears once a class with at least one placed session is selected —
    no extra query needed for the confirmation dialog's count, since
    `placedSlots.length` (the builder's own already-loaded state) is
    exactly the count that will be deleted. The dialog reads "This will
    delete N scheduled session(s) for {class}. This cannot be undone,"
    plus a note that assignments/credit hours stay intact.
  - **Per-semester-level batch** —
    `previewClearSemesterTimetable(semesterNumber)` (read-only) +
    `clearSemesterLevelTimetable(semesterNumber)`
    (`admin/auto-timetable/actions.ts`, `timetable.generate` — the same
    key that gates auto-generation itself, since "semesterNumber level"
    is this module's own batching concept, not something Academic
    Calendar's real-Semester lifecycle manages). Both always resolve
    against whichever real Semester is currently `isActive` (never a
    client-supplied semesterId), same "defaults to the active semester"
    convention as every workload-import variant on this page. Deletes
    every `TimetableSlot` for every class whose `currentSemesterNumber`
    matches the picked level, dean-scoped via `classDeanWhere` merged
    into the same `class` where-clause as `currentSemesterNumber` (built
    as one nested object, not two colliding top-level `class` keys — see
    the code comment for why that distinction matters). A new
    `ClearSemesterTimetableCard` on the Workload Import & Auto-Timetable
    page (`admin/auto-timetable/clear-semester-timetable-card.tsx`,
    rendered from `WorkloadImportPanel` alongside the existing
    `PendingAutoGenerateCard`, gated the same way): pick a semester level
    (reusing the same `semesterNumberOptions` the By-Semester import tab
    already computes — no new level-listing query), click "Clear
    timetable" to open a confirm dialog that fetches
    `previewClearSemesterTimetable` on open and shows the real total
    count plus a per-class breakdown list before anything is deleted; the
    confirm button is disabled while loading or when the count is zero.
  - Both actions are pure "collect the slot ids, one `deleteMany`, one
    summary audit entry" — no per-slot audit noise, matching the
    established one-entry-per-batch-operation convention
    (`TIMETABLE_CLEARED` for the per-class action, entityId = classId;
    `TIMETABLE_SEMESTER_CLEARED` for the batch action, entityId =
    semesterId) — and both are a genuine no-op (no delete call, no audit
    row) when there's nothing to clear, rather than writing an empty
    audit entry. Both trigger the existing best-effort `notifyTimetableChange`
    WhatsApp hook once per affected class (never per session, same
    convention as `buildClassTimetable`/`confirmAutoTimetableBatch`), and
    both `revalidatePath` every timetable route AND
    `/admin/workload-import` + `/dean/workload-import` — the latter is
    what makes the persistent "N assignment(s) not yet scheduled" card
    refresh correctly right after a clear, with no reload needed.
  - Tests: `admin/timetable/actions.test.ts` gained a `clearClassTimetable`
    suite (permission gate, ADMIN-unscoped vs. DEAN-scoped-via-
    classDeanWhere vs. out-of-scope-throws-CLASS_NOT_FOUND, the
    delete+audit+return-count happy path, the zero-slots no-op, the
    WhatsApp notify call, and that LecturerCourseAssignment is never
    touched). `admin/auto-timetable/actions.test.ts` gained
    `previewClearSemesterTimetable`/`clearSemesterLevelTimetable` suites
    (permission gates, NO_ACTIVE_SEMESTER, dean-scoping with the merged
    `class` where-clause asserted explicitly, per-class aggregation and
    sorting, the delete+audit+counts happy path, the zero-slots no-op,
    one-notification-per-affected-class, and the workload-import
    revalidate paths). No new `.tsx` unit tests — this codebase still has
    none. `tsc --noEmit`, ESLint, and the full Vitest suite (712 passing)
    were all run clean.
  - Verified `/admin/workload-import`, `/admin/timetable`, and
    `/admin/auto-timetable` still compile and serve under the existing
    dev server (clean 307 auth redirects, no new errors in the server
    log) — the confirmation dialogs and the actual delete flow were NOT
    visually verified end-to-end in a browser, same
    `next/navigation`-requires-a-real-authenticated-request constraint
    noted throughout this log; see the chat response for the manual
    testing plan handed to the user.

New feature — "Full width" toggle for the multi-class overview (branch
  `main`): a toggle button next to the auto-generate screen's semester
  filter (`admin/auto-timetable/auto-timetable-generator-client.tsx`)
  expands `MultiClassOverview`'s own card grid to the full available page
  width in place — no navigation, no fullscreen modal. State
  (`overviewFullWidth`) lives in the generator client, not inside
  `MultiClassOverview` itself, specifically so it survives that component
  being remounted (regenerating a preview, switching the semester filter)
  as well as opening/closing an individual class's fullscreen review —
  satisfying the "remember during the session" requirement for free,
  beyond just the closing/reopening-the-modal case explicitly asked for.
  Deliberately session-only (component state, no persistence) — not
  asked for, and this app has no per-user UI-preference storage to hang
  it on.
  - **Breakout mechanics**: this app's `AppShell` (`components/layout/
    app-shell.tsx`) has no separate max-width wrapper to fight — its
    `<main>` is just `p-4 sm:p-6`, and the sidebar is a fixed 256px column
    with no toggle of its own reachable from a nested page. So "full
    width" here means: `MultiClassOverview`'s root container gets
    `-mx-4 sm:-mx-6` (exactly canceling `<main>`'s own padding) when the
    prop is on, reaching the true available width — flush to the sidebar
    on the left, flush to the viewport edge on the right. The summary bar
    (class count + Scheduled/Flagged/Unscheduled badges + "Build all") is
    re-inset with a matching `mx-4 sm:mx-6` so it stays visually aligned
    with every other section on the page (the semester filter, banners,
    and "Assignments in this batch" table above it are NOT part of this
    breakout and stay at normal width, per the "only affects the OVERVIEW
    grid" requirement) — but the card GRID itself is deliberately left
    un-repadded, since re-adding the same padding there would cancel the
    extra width out entirely and defeat the point. `ClassFullscreenModal`
    needs no change at all: it's already `fixed inset-0` (viewport-
    relative), so it was already unaffected by anything about its
    ancestors' width, full-width toggle included.
  - **Grid density**: the card grid's own responsive breakpoints switch
    from the normal `grid-cols-1 md:grid-cols-2 xl:grid-cols-3` to
    `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4
    2xl:grid-cols-5` when full width — this, not the modest ~24-48px of
    reclaimed page padding, is what actually delivers "3-4+ columns
    instead of 2" on a normal monitor; the two changes are independent
    but always applied together via the one `fullWidth` prop.
  - **UI**: the toggle is a plain icon `Button` (`Maximize`/`Minimize`
    from lucide-react — deliberately different icons from `Maximize2`,
    which `ClassMiniCard`'s own per-class expand button already uses, so
    the two controls never read as the same action), `variant="default"`
    when on / `"outline"` when off (a pressed-button look, plus
    `aria-pressed`), with a `title`/`sr-only` label that flips between
    "Full width" and "Exit full width."
  - No new permission, no schema change, no new Server Action — this is
    pure client-side layout state. No new test file — this codebase has
    no `.tsx` unit tests anywhere (same as every other client-only UI
    change in this log); `tsc --noEmit`, ESLint, and the full Vitest
    suite (712 passing, unchanged — this touches no code any existing
    test exercises) were all run clean. `/admin/workload-import` and
    `/admin/auto-timetable` were confirmed to still compile/serve (clean
    307 auth redirects) under the existing dev server. The actual visual
    reflow was NOT verified end-to-end in a browser, same
    `next/navigation`-requires-a-real-authenticated-request constraint
    noted throughout this log.

Change — the multi-class overview's mini cards are now FULLY drag-and-drop
  interactive, not read-only (branch `main`): a class's card in the
  auto-generate overview grid used to require opening the per-class
  fullscreen modal to make any edit; now the mini grid itself supports the
  same interactions — drag a session to a different cell, drag an
  unscheduled chip from the card's own tray onto an open cell, or tap a
  placed session's delete icon to unschedule it — with the exact same
  conflict checking (room/lecturer/class hard rules) as everywhere else,
  live, at card scale. The per-class expand-to-fullscreen button stays
  (bigger view for touch devices or a crowded card) but is no longer
  required for any edit.
  - **Architecture**: this is mostly the "remove the read-only
    restriction" the request anticipated, plus one real refactor it
    required. `components/timetable/schedule-grid.tsx`'s compact scale
    was previously ALWAYS non-interactive (`CompactSessionChip`, a static
    `<div>`) — it now has a genuine compact-INTERACTIVE rendering:
    `PlacedCard` gained a `compact` prop producing a small draggable pill
    (course name + a tap-to-delete icon, no inline time/room editing —
    there isn't room for it at this scale and it wasn't asked for), and
    `DraggableChip` gained the same `compact` pill treatment for the
    unscheduled-chips tray. `CompactSessionChip` itself is unchanged and
    still used for a genuinely read-only compact grid
    (`scale="compact"` + `interactive={false}`) — no current caller uses
    that combination anymore, but the capability is kept since
    `ScheduleGrid` is a generic shared component.
  - **Drag-target sizing was addressed proactively, not left for
    "flag if difficult"**: both new compact draggables attach `useDraggable`'s
    listeners to the WHOLE pill, not a small handle icon within it (unlike
    the full-scale `PlacedCard`/`DraggableChip`, which use a dedicated
    `GripVertical` handle) — a ~10px icon alone would have been a
    genuinely hard target to grab accurately at card scale, especially on
    touch. Delete is a small tap icon on the pill itself rather than
    drag-to-trash (no `TrashDropZone` is rendered at compact scale at
    all) — dragging accurately onto a small dedicated trash target would
    be an even less forgiving gesture this small, and a tap target
    doesn't have that precision requirement. The compact chips tray is a
    wrapped row of pills ABOVE the grid (not a side-by-side 256px sidebar
    — there isn't that much spare width in a 3-5-column card grid).
    **Verdict on the request's own question**: with these two changes
    (whole-pill dragging, tap-not-drag delete), the compact scale is
    comfortable to use down to roughly a ~200px-wide card (the practical
    floor of the existing responsive grid's `md:grid-cols-2`+ breakpoints
    at common viewport widths) — no minimum card width was added to the
    grid CSS, since the existing breakpoints already stay comfortably
    above that floor in practice; this should still be spot-checked on an
    actual touch device per the testing plan below.
  - **State/handler unification**: `ClassFullscreenModal` used to own a
    local COPY of one class's state (seeded from a snapshot, merged back
    into the parent's `stateByClass` only on close) — that design existed
    specifically because mini cards were read-only and nothing else could
    change a class's state while the modal was open. Now that mini cards
    are live too, the modal was rewritten into a thin, stateless,
    presentational wrapper: `MultiClassOverview` owns `stateByClass` (the
    whole batch's editable preview state, unchanged) AND every mutating
    handler (`handleScheduleChip`/`handleMoveSession`/
    `handleUnscheduleSession`/`handleEditSessionTime`/
    `handleEditSessionRoom`, each taking a `classId` first argument and
    going through the exact same pure `lib/auto-timetable-preview-state.ts`
    functions as before), passed down IDENTICALLY to both a `ClassMiniCard`
    (schedule/move/unschedule only — no time/room editing at that scale)
    and, for whichever class is currently expanded, `ClassFullscreenModal`
    (all five). There is no more "merge back on close" step at all — a
    mini-card edit and a fullscreen edit are the same underlying state by
    construction, which is also what makes "Build all commits the final
    state of every card exactly as before, whether edits were made in
    mini view, fullscreen view, or both" true with zero special-casing.
    Per-class error-flash state (`errorCellByClass`, keyed by classId) is
    similarly lifted to `MultiClassOverview` so a rejected drop in one
    card's grid never flashes a cell in another card's.
  - **Conflict checking is unchanged in substance** — every handler still
    calls `otherClassesAsConflictCandidates(stateByClass, classId)` fresh
    at the moment of the operation (reading the current `stateByClass`
    render-scope value, same non-functional-updater pattern the old
    fullscreen modal already used) before delegating to the same
    `scheduleChipInClass`/`moveSessionInClass`/etc. pure functions from
    the prior phase — this is what makes a room/lecturer/class conflict
    against ANOTHER class's session (edited via ITS OWN mini card, live)
    caught correctly even though nothing here is a snapshot anymore.
  - No new permission, no schema change, no new Server Action — this is
    entirely a client-side interaction change on top of already-shipped,
    already-tested pure logic (`lib/auto-timetable-preview-state.test.ts`,
    unchanged — no new pure functions were added, only new callers of the
    existing ones). No new test file — this codebase has no `.tsx` unit
    tests anywhere. `tsc --noEmit`, ESLint, and the full Vitest suite (712
    passing, unchanged — this touches no code any existing test
    exercises) were all run clean. `/admin/workload-import` and
    `/admin/auto-timetable` were confirmed to still compile/serve (clean
    307 auth redirects) under the existing dev server. The actual
    drag-and-drop interaction at compact scale was NOT verified
    end-to-end in a browser (including the touch-usability verdict
    above, which is a reasoned judgment call, not a measured one), same
    `next/navigation`-requires-a-real-authenticated-request constraint
    noted throughout this log — see the chat response for the manual
    testing plan handed to the user.

New feature — Cross-period override, manual/per-session/opt-in only
  (branch `main`): see CLAUDE.md's "Period" business rule's new
  "Cross-period override" bullet above for the full current-state
  description — this entry is the changelog. Added
  `TimetableSlot.crossPeriodOverride` (migration
  `20260807123111_timetable_slot_cross_period_override`, additive,
  `@default(false)`) and threaded it through every session-editing
  surface via the shared `ScheduleGrid` component (a new optional
  `crossPeriodRows`/`onSetCrossPeriodOverride` prop pair, a `crossPeriod`
  marker on `ScheduleGridRow`, and a checkbox + inline shift-picker block
  on `PlacedCard`), the standalone single-slot Add/Edit dialog
  (`admin/timetable/timetable-client.tsx`), the live drag-and-drop
  builder (`admin/timetable/build-timetable-client.tsx`), and the
  auto-generate multi-class overview
  (`admin/auto-timetable/multi-class-overview.tsx` + its mini-card/
  fullscreen-modal children). Two new pure functions in
  `lib/auto-timetable-preview-state.ts`
  (`setCrossPeriodOverrideInClass`, plus a new optional 5th param on
  `editSessionTimeInClass`); `scheduleChipInClass`/`moveSessionInClass`
  derive the flag from the target row's own `crossPeriod` marker rather
  than a separate argument. The auto-generate algorithm itself
  (`lib/auto-timetable.ts`) needed ZERO changes — `ScheduledSession` has
  no such field, so it's structurally incapable of setting the override;
  an assignment it can't place in its own period still lands in
  Unscheduled exactly as before, left for manual placement with this
  override if the admin/dean chooses to. Visually flagged with a distinct
  violet badge/border (vs. the amber spacing-fallback `flagged`
  treatment) at every scale. Hard conflict rules (room/lecturer/class)
  are completely unaffected, since `findTimetableConflicts` has no period
  awareness at all.
  - Made `crossPeriodOverride` a plain required `z.boolean()` (not
    `.optional().default(false)`) in both `admin/timetable/schema.ts` and
    `admin/auto-timetable/schema.ts` — an optional-with-default field's
    diverging Zod input/output types broke react-hook-form's
    `zodResolver` generics in `timetable-client.tsx`; every real caller
    already supplies the field explicitly, so requiring it was free.
  - Tests: `lib/auto-timetable-preview-state.test.ts` gained 12 new cases
    (deriving the flag from `row.crossPeriod` on schedule/move including
    clearing it when moved back to a normal row, `editSessionTimeInClass`'s
    preserve-vs-explicit-set behavior, a full `setCrossPeriodOverrideInClass`
    suite, and `buildPreviewStateByClass` always seeding it false).
    `admin/timetable/actions.test.ts` and `admin/auto-timetable/
    actions.test.ts` each gained a persistence test confirming
    `crossPeriodOverride: true` reaches the real
    `prisma.timetableSlot.create`/`update`/`createMany` call. `tsc
    --noEmit`, ESLint, and the full Vitest suite (727 passing) were all
    run clean. `/admin/timetable`, `/admin/workload-import`, and
    `/admin/auto-timetable` were confirmed to still compile/serve (clean
    307 auth redirects) under the existing dev server — the actual
    checkbox/picker interaction and the violet visual flag were NOT
    verified end-to-end in a browser, same
    `next/navigation`-requires-a-real-authenticated-request constraint
    noted throughout this log; see the chat response for the manual
    testing plan handed to the user.

New feature — PDF/Excel export of the multi-class preview, color-coded by
  course (branch `main`): see CLAUDE.md's "Workload Excel import +
  auto-timetable generation" business rule's new "PDF/Excel export of the
  multi-class preview" bullet above for the full current-state description
  — this entry is the changelog. Two new packages: `exceljs` (cell-fill-
  color write support the app's existing `xlsx` dependency's free build
  doesn't have) and `jspdf` + `jspdf-autotable` (this app's first PDF-
  rendering dependency — CLAUDE.md previously documented adding one as
  explicitly deferred; this request is what triggered actually adding it).
  - `lib/course-colors.ts` (new, pure): `assignCourseColors(courseNames)`
    — deterministic, alphabetical-order color assignment keyed by course
    name, cycling the `dataviz` skill's validated 8-hue categorical
    palette through 3 lightness tiers (24 colors) for semesters with more
    than 8 courses, a disclosed departure from that skill's "never cycle
    past 8" chart rule justified by every colored cell here also carrying
    a visible course-name label (the rule's own "secondary encoding"
    mitigation). `pickTextColor` picks readable black/white text per
    generated fill via WCAG contrast.
  - `admin/auto-timetable/preview-export.ts` (new): `buildCourseColorMap`/
    `sessionsForCell`/`cellText`/`rowLabel`/`dayHeaders` (pure, shared by
    both builders) plus `buildPreviewWorkbook`/`downloadPreviewExcel`
    (`exceljs`: a "Legend" sheet then one sanitized-and-deduped sheet name
    per class, color-filled session cells) and `buildPreviewPdf`/
    `downloadPreviewPdf` (`jsPDF`+`jspdf-autotable`, landscape A4: a
    legend page then one page per class via `autoTable` with per-cell
    `fillColor`/`textColor`). Both run entirely client-side (dynamic
    `import()`, no Server Action) since the exported data is the admin/
    dean's in-memory preview state, which has no server-side existence
    until "Build all."
  - `lib/download.ts` gained `downloadBlob` (the same object-URL-and-click
    download mechanics `downloadBase64` already had, factored out and
    reused by both, since this export starts from a Blob directly rather
    than a server-returned base64 string).
  - `multi-class-overview.tsx` gained "Export Excel"/"Export PDF" buttons
    next to "Build all", each building a `PreviewExportData` from the
    CURRENT `stateByClass` (including any manual adjustments already made
    in mini-card or fullscreen editing — never the raw un-edited algorithm
    output once something's changed) via the same `rowsAndDaysForClass`
    helper the on-screen cards already use, so the export can never
    disagree with what's currently shown. Gained two new props
    (`semesterLabel`, `level`) purely to label the export, threaded down
    from `auto-timetable-generator-client.tsx`'s existing `group`/`level`
    state.
  - Tests: `lib/course-colors.test.ts` (9 cases — alphabetical-order base-
    hue assignment, same-course-same-color across repeats, order-
    independence/determinism, the 9th-course lightened-tier cycling,
    every generated color getting a readable text color, the empty-input
    case, and `pickTextColor`/`rgbToHex` directly). `admin/auto-timetable/
    preview-export.test.ts` (18 cases — the row-resolution heuristic
    including its closest-row fallback and day-exclusivity,
    buildCourseColorMap's per-export/cross-class color consistency,
    legend sorting, cellText's flagged/cross-period markers, row/day
    label formatting, file-name sanitization, and — against the real
    `exceljs` `Workbook`/`Worksheet` API, which runs fine under Node/
    Vitest — the Legend-sheet-first ordering, actual cell fill/value
    assertions, sheet-name dedup/truncation, and the no-fill-on-an-open-
    cell case; exceljs's first dynamic import needed a raised 20s
    `describe` timeout purely for its one-time module-load cost under
    Vitest, not a real hang). The `jsPDF`/`jspdf-autotable` PDF builder's
    internals were NOT unit tested (consistent with this codebase's
    established "no browser-only `.tsx`/UI-library-internals unit tests"
    precedent) — covered by `tsc --noEmit` (clean) and the manual testing
    plan handed to the user instead. `tsc --noEmit`, ESLint, and the full
    Vitest suite (754 passing) were all run clean. `/admin/workload-
    import`, `/admin/auto-timetable`, and `/admin/timetable` were
    confirmed to still compile/serve (clean 307 auth redirects) under the
    existing dev server. The actual exported PDF/Excel files' visual
    correctness (cell colors rendering as expected in a real spreadsheet/
    PDF viewer, page layout/pagination, legend readability) was NOT
    verified end-to-end in a browser, same `next/navigation`-requires-a-
    real-authenticated-request constraint noted throughout this log; see
    the chat response for the manual testing plan handed to the user.
  - Confirmed (not implemented, per the request's own "nice-to-have, not
    required" scoping): `assignCourseColors` is generic and has zero
    dependency on the preview-state pipeline, so the manual drag-and-drop
    Timetable Builder, the "Now" view's existing Excel export, and the
    Dean/Lecturer reports could all reuse it for the same course-color
    consistency later — none of them were touched by this change.

Fix — PDF export layout cutoff: each class's grid now scales to fit ONE
  page (branch `main`): the multi-class preview's "Export PDF"
  (`admin/auto-timetable/preview-export.ts`'s `buildPreviewPdf`, see the
  "PDF/Excel export of the multi-class preview" entry above for the
  feature this fixes) was spilling a class's grid across multiple pages
  mid-table instead of fitting it on one.
  - **Root cause, confirmed before writing any fix**: `autoTable` was
    called with a FIXED `fontSize: 8`/`cellPadding: 4` for every class's
    table regardless of that class's actual Shift-row count or how much
    text each cell wraps to (course + lecturer, sometimes several
    sessions stacked in one cell). `jspdf-autotable`'s own default
    behavior when a table's height exceeds what's left on the page is to
    silently keep drawing onto fresh pages — there's no built-in
    shrink-to-fit. **Width was investigated and ruled out**: the export
    already always renders in landscape, and this app's own day-count
    ceiling (`lib/timetable-days.ts`: FT = 5 days, PT = 2) fits
    comfortably within landscape A4 width regardless of study mode — a
    wide class just gets more (fully visible) columns, it never runs off
    the page edge. **Height was the real overflowing axis**: a class with
    more Shift rows, or with cells stacking multiple sessions, needs more
    vertical space, and nothing scaled to account for that — an FT class
    (up to 5 days × however many Shift rows exist) is inherently denser
    than a PT class (2 days), which is exactly the asymmetry the bug
    report described.
  - **Fix**: for EACH class independently, `pickFontSizeForClass` (a new
    exported, pure, directly-unit-tested function) measures how tall that
    class's table would ACTUALLY render at each candidate font size (10,
    9, 8, 7, `MIN_READABLE_FONT_SIZE` = 6pt) — using jsPDF's own
    `splitTextToSize()` against that class's real computed day-column
    width (`estimateTableHeight`, so the measurement reflects genuine
    wrapped line counts, not a guess) — and picks the LARGEST candidate
    whose estimated height (with an 8% safety margin,
    `HEIGHT_SAFETY_MARGIN`, since autoTable's own internal rounding isn't
    identical to the estimate) fits within the page's remaining height.
    An FT class with many rows/dense cells and a PT class with few
    rows/light cells are therefore sized completely independently of each
    other — never a single fixed size applied to both. `autoTable` also
    gained `margin: { left, right, bottom: TABLE_BOTTOM_MARGIN }` and
    `rowPageBreak: "avoid"` so, in the rare case a class still doesn't fit
    (see below), a single row is never split mid-row across a page
    boundary.
  - **Never silently shrunk into illegibility, and never silently left
    cut off** — `MIN_READABLE_FONT_SIZE` (6pt) is a hard floor:
    `pickFontSizeForClass` never returns anything smaller. A class dense
    enough that even the floor doesn't fit is left to spill onto a
    further page (`jspdf-autotable`'s own default pagination, unchanged)
    rather than shrunk further, and its name is collected into
    `buildPreviewPdf`'s new `overflowClassNames` return value —
    `buildPreviewPdf` now returns `{ doc, overflowClassNames }` instead of
    a bare `jsPDF` document. `downloadPreviewPdf` threads this through as
    `Promise<{ overflowClassNames: string[] }>`, and
    `multi-class-overview.tsx`'s `handleExportPdf` shows a
    `toast.warning` naming every such class after the download completes
    — satisfying the explicit "tell me instead of silently producing... a
    still-cut-off PDF" requirement. In ordinary use this list is expected
    to be empty; it only ever fires for a genuinely pathological class
    (see the test below).
  - Color-coding and the legend page are byte-for-byte unchanged — this
    was a layout/sizing fix only, confirmed by the pre-existing
    `buildPreviewWorkbook` (Excel) tests and the color-related
    `buildPreviewPdf` code paths (`hexToRgbTuple`, `columnStyles`,
    `headStyles`) all being untouched by this change.
  - Tests (`preview-export.test.ts`, appended, not rewritten — all 18
    pre-existing tests in this file still pass unmodified): a new
    `describe("pickFontSizeForClass", ...)` proves a light PT-shaped class
    (2 days, 2 rows) picks the largest candidate (10pt) and fits; a dense
    FT-shaped class (5 days, 8 rows, 2 stacked sessions per cell with
    long course/lecturer names) picks a strictly SMALLER font than the PT
    class while still fitting one page (`fits: true`) and never dropping
    below `MIN_READABLE_FONT_SIZE`; an artificially tiny `availableHeight`
    exercises the genuine-overflow branch deterministically
    (`fits: false`, floor size returned). A new
    `describe("buildPreviewPdf", ...)` proves, end-to-end, that a PT class
    and a dense FT class together produce EXACTLY `1 (legend) + 2 (one per
    class)` pages with an empty `overflowClassNames` — the direct proof of
    "both fit cleanly on one page each" the fix was built to satisfy — and
    a separate, deliberately pathological 60-row class (far denser than
    the "dense FT" fixture) correctly produces MORE pages than
    `1 + classCount`, with `overflowClassNames` naming exactly that one
    class and no others. Full suite: 759 passing. `tsc --noEmit` and
    ESLint on the touched files are clean.
  - Not yet visually verified end-to-end in a browser — same
    `next/navigation`-requires-a-real-authenticated-request constraint
    noted throughout this log; the fix WAS verified numerically (real
    `jsPDF`/`jspdf-autotable` page counts via `doc.getNumberOfPages()`,
    not a mock) for both an FT-shaped and a PT-shaped class, per the
    request's explicit testing requirement.

New feature — Optional lecturer availableDays, a hard scheduling
  constraint when set (branch `main`): see CLAUDE.md's "Class Timetable"
  business rule's new "Lecturer availableDays" bullet above for the full
  current-state description — this entry is the changelog. `Lecturer`
  gains `availableDays DayOfWeek[] @default([])` (migration
  `20260807151719_lecturer_available_days`, additive — every pre-existing
  lecturer keeps this empty, meaning unrestricted, with zero behavior
  change).
  - **Lecturer Registration/Edit** (`admin/lecturers/`): a new
    `DaysCheckboxList` component (checkbox-per-day, `ALL_DAYS_ORDER`
    order) is used both in the registration form (a new `availableDays`
    Zod field, plain required `z.array(...)` not
    `.optional().default([])` — the by-now-established
    diverging-input/output-types reason this app always uses for
    react-hook-form fields) and a new click-to-edit "Available days"
    table column/dialog (mirroring the existing Phone/Department
    columns exactly), backed by a new `updateLecturerAvailableDays`
    action (`lecturerAvailableDaysSchema`, audited as
    `LECTURER_AVAILABLE_DAYS_UPDATED` with old/new values).
  - **`lib/timetable-days.ts`** gained three small pure helpers, all
    unit-tested: `formatDayList` (Saturday-first "Sat/Wed" formatting,
    used in every generated message below), `restrictDaysToLecturerAvailability`
    (intersects a day list with a lecturer's `availableDays`, no-op when
    empty), and `lecturerAvailabilityConflictReason` (the workload-import
    "can never possibly be satisfied" check).
  - **`lib/auto-timetable.ts`**: `AssignmentToSchedule` gained a required
    `lecturerAvailableDays` field, threaded through to
    `ScheduledSession`/`UnscheduledItem` too (so it survives into the
    client-side preview-state model below). Inside
    `generateTimetableForBatch`, `validDays` is now
    `restrictDaysToLecturerAvailability(classValidDays, a.lecturerAvailableDays)`
    — computed ONCE per assignment and reused by both placement passes,
    so the spacing-fallback pass can still reuse the lecturer's one
    allowed day (at a different shift/time) but can never spill onto a
    day outside the restriction. An upfront check reports (and skips) an
    assignment whose restriction has ZERO overlap with the class's own
    valid days at all, before any shift-combo work; the per-session
    "still couldn't place it" reason distinguishes that zero-overlap case
    from "every allowed day is fully booked," both naming the exact
    restricted days via `formatDayList`.
  - **`components/timetable/schedule-grid.tsx`**: `ScheduleGridSession`/
    `ScheduleGridChip` gained an optional `lecturerAvailableDays`.
    `ScheduleGrid` now tracks, from `activeDrag`, the currently-dragged
    item's `lecturerAvailableDays` (null when unrestricted or nothing is
    being dragged) and passes a per-cell `restrictedDayBlocked` flag down
    to `GridCell`, which both disables that cell as a dnd-kit drop target
    (`useDroppable({ disabled })` — a genuinely blocked drop, not just a
    visual) and greys it out (`bg-muted/60 opacity-50`, a distinct
    treatment from the existing error/hover/cross-period cell states).
    This is per-DRAG, not per-row — a class's grid can contain sessions
    from several lecturers with different restrictions, so the greying
    only ever applies while dragging THAT lecturer's own chip/session.
    `lib/auto-timetable-preview-state.ts`'s `PreviewSession`/`PreviewChip`/
    `PreviewAssignmentMeta` all gained the same field, populated in
    `buildPreviewStateByClass` and copied onto a newly-scheduled session
    in `scheduleChipInClass` (a chip carries no `lecturerId` of its own
    to look it up from, hence `meta`) — every OTHER preview-state
    function (`moveSessionInClass`, `editSessionTimeInClass`, etc.)
    needed no change, since they all already spread `{...session, ...}`.
  - **Every caller building `ScheduleGridSession`/`ScheduleGridChip`
    objects updated to pass the field through**: the manual Timetable
    Builder (`admin/timetable/build-timetable-client.tsx`, reading
    `slot.assignment.lecturer.availableDays`/`a.lecturer.availableDays`
    — already present on both queries' results since they already
    `include: { lecturer: true }`, no query change needed), and the
    auto-generate multi-class overview's `toGridSessions`/`toGridChips`
    plus its `assignmentMetaById` construction
    (`admin/auto-timetable/multi-class-overview.tsx`/
    `auto-timetable-generator-client.tsx`). The single-slot fullscreen
    modal and mini-cards need no changes of their own — they only ever
    receive already-converted props from the overview.
  - **Single-slot Add/Edit dialog** (`admin/timetable/
    timetable-client.tsx`): `validDays` now also passes through
    `restrictDaysToLecturerAvailability` using the selected assignment's
    `lecturer.availableDays` (present the same "already included" way).
    A small note under the Day field explains a partial narrowing; a
    dedicated amber banner (matching the existing `classPeriodMissing`
    banner's styling, linking to Lecturer Registration instead of Class
    edit) appears when the restriction leaves literally no day pickable
    for the current class.
  - **Workload Excel import** (`admin/workload-import/actions.ts`
    Bulk, `class-actions.ts` By Class, `semester-actions.ts` By
    Semester): each variant's lecturer-resolution step now also calls
    `lecturerAvailabilityConflictReason(class.studyMode,
    resolvedLecturer.availableDays)` and adds the result as a row issue
    when non-null — a row whose matched lecturer can NEVER teach this
    class on any valid day, flagged as a real ERROR at import time
    rather than silently creating an assignment that can then never be
    auto-generated. `WorkloadImportRow` (the full, round-tripped-through-
    confirm schema) gained a required `lecturerAvailableDays` field,
    threaded into `CreatedAssignmentSummary` (and therefore into
    `getPendingAutoTimetableAssignments`'s persistent re-entry point and
    the generator's `assignmentMetaById`) — resolved directly at Bulk's
    own preview time, and via a small fresh `prisma.lecturer.findMany`
    lookup at CONFIRM time for the By Class/By Semester variants (whose
    own narrower client-round-tripped row shapes don't carry the field,
    consistent with those actions already re-deriving
    lecturerId/lecturerName's *validity* — though not re-fetching those
    two — from the client at confirm time).
  - Tests: `lib/timetable-days.test.ts` gained coverage for all three new
    helpers; `lib/auto-timetable.test.ts` gained a dedicated
    "lecturer availableDays (OPTIONAL hard constraint)" describe block
    (unrestricted-behaves-as-before, restricted-only-within-intersection,
    never-bypassed-even-when-another-day-is-open, fallback-reuses-the-
    one-allowed-day-not-a-different-one, both specific Unscheduled
    reasons, and no-cross-lecturer-bleed-in-the-same-batch);
    `lib/auto-timetable-preview-state.test.ts` gained propagation
    coverage through `buildPreviewStateByClass`/`scheduleChipInClass`;
    `admin/lecturers/actions.test.ts` gained `updateLecturerAvailableDays`
    coverage plus registration-with-availableDays-set;
    `admin/auto-timetable/actions.test.ts` gained an end-to-end
    DB-row-to-algorithm coverage pair (restricted lecturer scheduled only
    within their days; zero-overlap reported with the specific reason);
    `admin/workload-import/actions.test.ts`,
    `class-actions.test.ts`, and `semester-actions.test.ts` each gained
    an availableDays-conflict-is-an-ERROR case (plus, for By Class, a
    fresh-lookup-not-round-tripped confirm-time case) — all three files'
    pre-existing `lecturer` fixtures were also fixed to include
    `availableDays: []`, since the field is now unconditionally read.
    Full suite: 790 passing. `tsc --noEmit` and ESLint are clean.
  - Not yet visually verified end-to-end in a browser — same
    `next/navigation`-requires-a-real-authenticated-request constraint
    noted throughout this log; the Prisma migration WAS applied to and
    verified against the real dev DB (a genuine, not simulated,
    `prisma migrate dev` run).

Business rule change — Lecturer availableDays moves from a permanent
  Lecturer Registration field to a per-generation-run wizard step (branch
  `main`): see CLAUDE.md's "Lecturer availableDays" business rule above
  for the full current-state description — this entry is the changelog.
  The previous phase (see the "New feature — Optional lecturer
  availableDays" entry above) put a permanent checkbox-per-day field on
  Lecturer Registration/Edit; this phase reverts that specific UI and
  moves the SAME underlying `Lecturer.availableDays` column to being set
  fresh every time the auto-generate wizard runs, since a lecturer's real
  availability changes semester to semester rather than being a fixed
  fact about them. No schema change — `Lecturer.availableDays` itself is
  untouched, still the one column every consumer reads.
  - **Reverted** (`admin/lecturers/`): `lecturerRegistrationSchema` lost
    its `availableDays` field; `registerLecturer` no longer writes it at
    create time; `updateLecturerAvailableDays`/`lecturerAvailableDaysSchema`
    /`LecturerAvailableDaysInput` were deleted outright (dead code, not
    deprecated-in-place); `lecturers-client.tsx` lost `DaysCheckboxList`,
    the registration form's "Available days" field, the table's
    "Available days" column, and the click-to-edit dialog — byte-for-byte
    back to how the page looked before that phase. Lecturer Registration
    no longer asks about availability at all.
  - **New: the "Lecturer availability" wizard step**
    (`admin/auto-timetable/lecturer-availability-step.tsx`) — a new
    `LecturerAvailabilityStep` component, and a new
    `saveLecturerAvailableDaysForGeneration` Server Action
    (`admin/auto-timetable/actions.ts`, gated on `timetable.generate`,
    dean-scoped via `lecturerDeanWhere`, one transaction of per-lecturer
    `tx.lecturer.update` calls with `BULK_TRANSACTION_OPTIONS` since each
    lecturer gets a genuinely different value, audited as
    `LECTURER_AVAILABLE_DAYS_SET_FOR_GENERATION`) plus its schema
    (`lecturerAvailabilityUpdateSchema`/`lecturerAvailabilityUpdatesSchema`
    in `admin/auto-timetable/schema.ts`). Wired into
    `auto-timetable-generator-client.tsx`: a new `needsAvailabilityStep`
    gate (per-level, via a new `availabilityConfirmedKeys` Set) makes the
    existing auto-preview effect bail out and render
    `LecturerAvailabilityStep` instead, populated from the batch's
    already-loaded `CreatedAssignmentSummary[]` deduped by lecturerId (no
    new query); confirming the step saves, marks that level's key
    confirmed, and calls the same `handlePreview()` the effect would have
    called, so exactly one preview fetch still happens, just after the
    step instead of racing it. Re-selecting a level not yet visited this
    session (or one whose assignments involve different lecturers) always
    shows the step again with THAT batch's own lecturers, satisfying "set
    different days for the same lecturer across different runs" — since
    `Lecturer.availableDays` is one shared column, a later run's save
    simply overwrites whatever an earlier run in the same or a past
    session left there. A new "Edit lecturer availability for this
    level" link lets the admin/dean deliberately reopen the step for the
    CURRENTLY selected level too, without switching away and back. A new
    `savedAvailabilityByLecturer` local map layers on top of the
    (never-refetched-mid-session) `createdAssignments` prop for both the
    step's own pre-fill and `assignmentMetaById`'s `lecturerAvailableDays`
    (used when manually dragging a previously-unscheduled chip in the
    overview after the step already ran once this session) — so neither
    goes stale relative to what was actually just saved.
  - **Everything else is unchanged, by design** — the algorithm's hard
    constraint (`lib/auto-timetable.ts`), the manual Builder's/single-
    slot dialog's drag/day restrictions, and the workload Excel import's
    `lecturerAvailabilityConflictReason` validation all still just read
    `Lecturer.availableDays` exactly as before; none of them care where
    or when it was last set. The single-slot dialog's "no day can be
    picked" banner (`admin/timetable/timetable-client.tsx`) had its
    guidance text updated — it used to link to Lecturer Registration
    (which no longer has an availableDays editor); it now points at the
    "Lecturer availability" step in Generate Timetable instead, with no
    broken/misleading link.
  - Tests: `admin/lecturers/actions.test.ts` reverted back to its
    pre-availableDays shape (15 tests, the `updateLecturerAvailableDays`
    describe block and the availableDays-specific registration
    cases/fixtures removed). `admin/auto-timetable/actions.test.ts`
    gained a `saveLecturerAvailableDaysForGeneration` describe block (7
    cases — permission gate, empty-input no-op, the per-row-update-in-
    one-transaction happy path, dean scoping with silent skip of an
    out-of-scope lecturer, the audit payload, and an explicit
    overwrites-a-previous-run's-value case proving the "re-entered fresh
    every cycle" behavior). Full suite: 791 passing. `tsc --noEmit` and
    ESLint are clean.
  - Not yet visually verified end-to-end in a browser — same
    `next/navigation`-requires-a-real-authenticated-request constraint
    noted throughout this log.

Business rule change — Lecturer availability upgraded from day-only to
  day+shift granularity (branch `main`): see CLAUDE.md's "Lecturer
  availableDays" business rule above for the full current-state
  description — this entry is the changelog. A lecturer can now be
  restricted to specific SHIFTS within specific days (e.g. Tue: Subax
  1st+2nd only, Sat: Subax 2nd+3rd only), not just whole days; a plain
  day-level restriction (no shifts specified) still means "any shift
  that day," so nothing about the simpler case's behavior changed.
  - **Schema**: `Lecturer.availableDays DayOfWeek[]` is GONE, replaced by
    a `LecturerAvailability` join table (`lecturerId, dayOfWeek,
    shiftId` nullable — migration
    `20260807160000_lecturer_availability_day_shift`, applied via
    `prisma migrate deploy` after being hand-written since the
    environment's non-interactive shell blocks `migrate dev`'s
    destructive-column-drop confirmation prompt; the 53 existing
    non-null `available_days` values dropped by this migration are
    stale prior-run values by design — availability is re-entered fresh
    every generation cycle, so nothing meaningful was lost). `shiftId
    NULL` = day-level-only; one-or-more rows with `shiftId` SET for the
    same day = day+shift-level, never mixed within one day (an app-layer
    guarantee via delete-then-recreate, not a DB constraint — see the
    model's own schema comment for why a clean partial-unique-index
    shape isn't available here).
  - **`lib/timetable-days.ts`** gained the day+shift pure-logic layer,
    replacing the old flat-`DayOfWeek[]` functions outright (not kept
    alongside): `LecturerAvailabilityShiftRef`/`LecturerAvailabilityDayRule`
    types, `restrictedDaysForLecturer` (day-level intersection, was
    `restrictDaysToLecturerAvailability`), `isShiftAllowedForLecturerOnDay`
    (new — the per-cell check), `formatAvailabilityRules` (new, replaces
    `formatDayList` for restriction messages — `formatDayList` itself is
    kept, still used elsewhere for plain day lists), `groupLecturerAvailabilityRows`
    (new — raw DB rows -> the day-rule shape, the one place this
    grouping logic lives), and `lecturerAvailabilityConflictReason`
    (signature grew a `period` parameter and a second, shift-aware
    unsatisfiability check — see below).
  - **`lib/auto-timetable.ts`**: `AssignmentToSchedule`/`ScheduledSession`/
    `UnscheduledItem` all renamed `lecturerAvailableDays: DayOfWeek[]` to
    `lecturerAvailability: LecturerAvailabilityDayRule[]`.
    `findFirstOpenSlot` gained a `lecturerAvailability` parameter and now
    checks `isShiftAllowedForLecturerOnDay` for every (day, shift) pair
    it tries, in BOTH placement passes AND for an explicit shift
    override (deliberately never exempt from this hard constraint, even
    though an override IS exempt from the day-reuse spacing fallback) —
    the day-level upfront check and reason messages were updated to use
    `formatAvailabilityRules`/the new "no open slot within those" wording
    instead of the old day-only phrasing.
  - **`components/timetable/schedule-grid.tsx`**: `ScheduleGridSession`/
    `ScheduleGridChip.lecturerAvailableDays?: DayOfWeek[]` became
    `lecturerAvailability?: LecturerAvailabilityDayRule[]`.
    `GridCell`'s `restrictedDayBlocked` (whole-day-column greying) became
    `restrictedCellBlocked`, computed per (row, day) via
    `isShiftAllowedForLecturerOnDay(day, row.id, activeLecturerAvailability)`
    — a grid row's `id` IS the real Shift id it represents (every row
    ultimately comes from a real `Shift` template), which is what makes
    per-shift-row greying possible with no new row metadata needed.
  - **Wizard step rewritten** (`admin/auto-timetable/
    lecturer-availability-step.tsx`): from a flat day-checkbox list to a
    collapsible per-lecturer day list where each checked day reveals an
    optional shift multi-select scoped to that lecturer's own FT/PT
    shift catalog for the batch (`LecturerAvailabilityRow` gained
    `shiftOptions`, computed in `auto-timetable-generator-client.tsx`
    from the union of studyModes among that lecturer's own assignments
    in the batch). Local state changed from `Map<lecturerId,
    DayOfWeek[]>` to `Map<lecturerId, Map<DayOfWeek, Set<shiftId>>>` (a
    day PRESENT in the inner map = checked; its shift-id set, if
    non-empty, is the day's shift restriction).
  - **`admin/auto-timetable/schema.ts`/`actions.ts`**:
    `lecturerAvailabilityUpdateSchema` changed from `{lecturerId,
    availableDays: DayOfWeek[]}` to `{lecturerId, availability:
    {dayOfWeek, shiftIds: string[]}[]}`. `saveLecturerAvailableDaysForGeneration`
    rewritten from a per-lecturer `tx.lecturer.update` loop to a
    delete-all-then-recreate against `LecturerAvailability`
    (`tx.lecturerAvailability.deleteMany` + one batched `createMany`,
    still inside `BULK_TRANSACTION_OPTIONS`) — necessarily so, since a
    single lecturer can now need multiple rows (one per allowed shift on
    a shift-restricted day). Gained a `prisma.shift.findMany` existence
    check before writing, silently dropping any submitted shift id that
    doesn't resolve to a real, non-deleted Shift.
  - **`admin/timetable/queries.ts`**: every `lecturer: true` include that
    feeds the manual Builder/single-slot dialog became `lecturer:
    lecturerWithAvailability` (a new shared `{include: {availability:
    {include: {shift: true}}}}` constant) — a plain `lecturer: true`
    only returns the Lecturer's own scalars, never its relations, so
    `lecturer.availability` would otherwise always be `undefined`.
  - **Workload import** (`admin/workload-import/actions.ts`/
    `class-actions.ts`/`semester-actions.ts`): every `prisma.lecturer.findMany()`
    call gained `include: { availability: { include: { shift: true } } }`;
    every `lecturerAvailabilityConflictReason` call site now also passes
    the resolved class's `period`, alongside `groupLecturerAvailabilityRows`
    to build the `rules` argument from the raw fetched rows.
    `WorkloadImportRow`'s `lecturerAvailableDays: DayOfWeek[]` field
    became `lecturerAvailability: LecturerAvailabilityDayRule[]` (with a
    matching Zod shape carrying each shift's id/name/studyMode/period,
    so a round-tripped OK row never needs a second lookup to redisplay
    or reuse it). `CreatedAssignmentSummary` (`admin/workload-import/
    actions.ts`) mirrors the same rename.
  - Tests: `lib/timetable-days.test.ts` rewritten for the new function
    set (36 tests — day-level intersection, the per-cell shift check
    including the "two different days' restrictions stay fully
    independent" case, `formatAvailabilityRules`'s day-vs-shift-
    restricted formatting, `groupLecturerAvailabilityRows`'s raw-row
    grouping, and both branches of the upgraded conflict-reason check).
    `lib/auto-timetable.test.ts`'s lecturer-availability describe block
    gained day+shift cases on top of the existing day-level ones (49
    tests total) — exact-(day,shift)-combination-only placement, a
    disallowed shift on an otherwise-open allowed day being rejected,
    two days' restrictions staying independent within the SAME
    assignment, the specific day+shift reason message, and an explicit
    shift override still being rejected when it's outside the
    restriction (never exempt). `lib/auto-timetable-preview-state.test.ts`
    and `admin/auto-timetable/actions.test.ts` updated their fixtures/
    assertions to the new shape (the latter's
    `saveLecturerAvailableDaysForGeneration` suite rewritten around
    delete-then-recreate semantics, including a shift-id-doesn't-exist
    case). All three workload-import test files
    (`actions.test.ts`/`class-actions.test.ts`/`semester-actions.test.ts`)
    updated their `lecturer`/`pendingRow` fixtures from `.availableDays`
    to `.availability` (raw-row shape) and gained a day+shift-aware
    zero-day-overlap case; `class-actions.test.ts` additionally gained a
    same-day-overlap-but-wrong-period-shifts case. Full suite: 819
    passing. `tsc --noEmit` and ESLint are clean.
  - Not yet visually verified end-to-end in a browser — same
    `next/navigation`-requires-a-real-authenticated-request constraint
    noted throughout this log.

Improvement — Auto-generate algorithm gains backtracking + pre-generation
  feasibility validation (branch `main`): see CLAUDE.md's "Workload Excel
  import + auto-timetable generation" business rule's new
  "Pre-generation feasibility validation" and "Backtracking search (Phase
  2...)" bullets above for the full current-state description — this
  entry is the changelog.
  - **Backtracking** (`lib/auto-timetable.ts`): `generateTimetableForBatch`
    gained an optional 4th `options` param
    (`timeBudgetMs`/`maxDisplacementDepth`/`now`, all defaulted — every
    existing caller is unaffected). Phase 1 (the pre-existing two-pass
    greedy placement) is unchanged in behavior; anything it leaves
    unresolved is now retried by a new bounded Phase 2 (`tryResolve`/
    `runBacktrackingRepair`) that can displace and relocate one already-
    placed BATCH session (never a pre-existing DB row) per candidate slot,
    recursively up to `maxDisplacementDepth` (default 2), before finally
    giving up. Caught and fixed a real bug during this feature's own
    review, before it shipped: a displaced session's own relocation search
    didn't exclude the exact slot being freed up for it, so it could
    "relocate" right back into that same slot the instant its old
    placement was tentatively removed — silently double-booking the room.
    Fixed by threading `reservedSlots` (every (day,shift) an ancestor in
    the current displacement chain has already claimed) through the whole
    recursion and `findFirstOpenSlot`'s new `avoidSlots` param; a
    dedicated regression test (`lib/auto-timetable.test.ts`) reproduces
    the exact scenario and asserts no two scheduled sessions in the same
    room ever share a (day, shift) pair. `GenerationResult` gained
    `backtrackingStats` (`attempted`/`resolved`/`timedOut`/`elapsedMs`).
  - **Pre-generation feasibility validation**: new pure
    `checkBatchFeasibility`/`formatFeasibilityMessage`/
    `buildShiftsByStudyMode` exports in `lib/auto-timetable.ts`. A new
    `FeasibilityWarningStep` component
    (`admin/auto-timetable/feasibility-warning-step.tsx`) is wired into
    `auto-timetable-generator-client.tsx` as a step shown between
    "Lecturer availability" (if that ran) and the preview, whenever
    `checkBatchFeasibility` finds at least one lecturer whose required
    session time exceeds their available time — computed entirely
    client-side from data already loaded (the same `AssignmentToSchedule[]`
    shape the real preview request builds, plus `shifts` grouped via the
    new `buildShiftsByStudyMode`), no extra round trip. "Continue anyway"
    proceeds to the preview (tracked per-level in a new
    `feasibilityBypassedKeys` state, mirroring `availabilityConfirmedKeys`);
    "Edit lecturer availability" jumps back to that step. Editing
    availability for a level (from either that step's own link or the
    pre-existing "Edit lecturer availability for this level" link) clears
    any stale bypass for that level, so a just-changed number always gets
    a fresh check. The preview-loading message was updated to "Searching
    for the best schedule… this may take a few seconds," and a new
    result-level note surfaces `backtrackingStats` ("Backtracking search
    placed N of M session(s) that a simple pass would have left
    Unscheduled…") whenever it ran.
  - Tests: `lib/auto-timetable.test.ts` gained 15 new cases (single-
    displacement rescue, a 2-level displacement chain, the double-booking
    regression above, the pigeonhole-limit-still-holds case, hard-rule
    adherence during a rescue, the time-budget cutoff via an injectable
    clock, `maxDisplacementDepth` actually bounding the search, and a
    `checkBatchFeasibility`/`formatFeasibilityMessage` suite covering the
    exact "15h needed, 9h available" shape asked for, an unrestricted
    lecturer's full-capacity calculation, the zero-availability message,
    multi-lecturer grouping/sorting, and explicit shift-override hours).
    Full suite: 834 passing. `tsc --noEmit` and ESLint are clean.
  - **Verified against the real dev DB** with a temporary, read-only
    diagnostic script (not committed — deleted after use), run against
    whatever pending workload-import assignments genuinely existed at the
    time: 35 pending assignments, semester level 3, 1 real semester.
    BEFORE (backtracking disabled via `maxDisplacementDepth: 0`, i.e. the
    prior single-pass behavior): 64 scheduled normally, 0 fallback, 6
    Unscheduled (70.0ms). AFTER (backtracking enabled, defaults): 62
    normal, 4 fallback, 4 Unscheduled (34.4ms total; the backtracking
    search itself took 15ms and rescued 2 of the 6 originally-unresolved
    sessions). The remaining 4 Unscheduled sessions all belonged to the
    SAME lecturer (Client/Server Database (SQL), two classes, two sessions
    each) — and the SAME script's feasibility check, run independently
    over all pending assignments with zero synthetic/fabricated data,
    flagged that exact lecturer as infeasible (needs 15h, only 9.5h
    available) — a genuine real-world confirmation of both halves of this
    feature working together, not just the unit tests.
  - Not yet visually verified end-to-end in a browser for the UI half
    (the new Feasibility check step, the backtracking-stats note, the
    updated loading copy) — same `next/navigation`-requires-a-real-
    authenticated-request constraint noted throughout this log; the
    algorithm half (backtracking + feasibility math) WAS verified directly
    against real data, per the request's own explicit testing requirement,
    as described above.

Security hardening — Session expiry: browser-session cookie + 30-minute
  idle timeout (branch `main`): see CLAUDE.md's "Stack" section's new
  "Session policy" bullet above for the full current-state description —
  this entry is the changelog. Applies uniformly to every role (admin/
  dean/lecturer/student — verified no role-specific session handling
  existed anywhere before this change). Confirmed before making any
  change that no "remember me"/"stay logged in" feature exists anywhere
  in the app (grepped the login page/form and every session-cookie call
  site) — nothing to reconcile this against.
  - **Cookie**: `app/login/actions.ts`'s `cookieStore.set(...)` for
    `SESSION_COOKIE_NAME` dropped its `expires: expiresAt` option
    entirely — it's now a plain browser-SESSION cookie (no `maxAge`, no
    `expires`), so the browser discards it on close and a closed-then-
    reopened browser always needs a fresh login, independent of whether
    the underlying DB `Session` row is still otherwise valid. The DB
    row's own `expiresAt` (7-day absolute ceiling) is completely
    unchanged — it's still written and still enforced, just no longer
    mirrored into the cookie's own lifetime.
  - **Idle timeout**: new `Session.lastActivityAt` column (`DateTime
    @default(now())`, migration
    `20260826143441_session_last_activity_idle_timeout` — additive, no
    backfill needed since `@default(now())` seeds every pre-existing row
    at migration time, which simply gives already-logged-in sessions a
    fresh 30-minute window post-deploy rather than instantly expiring
    them). `lib/auth.ts` gained `IDLE_TIMEOUT_MS` (30 minutes) and
    `isSessionIdleExpired(lastActivityAt)`; `getCurrentUser()` now checks
    it alongside the pre-existing `expiresAt` check — `getCurrentUser()`
    already independently re-checked `expiresAt` on top of `proxy.ts`'s
    own check, so this is the same defense-in-depth duplication now
    applied to the idle check too. `proxy.ts` — the one gate every request passes through,
    including Server Actions, since they POST to the same route — is
    the enforcement point: on a request with a still-valid (non-idle,
    non-expired) session it bumps `lastActivityAt` to now via one
    `prisma.session.update`; on an idle-expired one it treats the
    request as unauthenticated, clears the cookie, and redirects to
    `/login?reason=idle_timeout` (landing directly on `/login` with a
    stale idle cookie just clears it silently, no redirect loop). The
    login page (`app/login/page.tsx`) reads that `reason` param via a
    new `SessionExpiryNotice` component (wrapped in its own `Suspense`
    boundary, since `useSearchParams` requires one) and shows "Your
    session expired due to inactivity — please log in again." as both an
    inline banner and a toast.
  - **Deliberately NOT done**: no deletion of the idle-expired `Session`
    row (matches the pre-existing convention of just treating an
    absolute-`expiresAt`-expired row as invalid without deleting it —
    the row simply keeps failing the idle check forever since nothing
    is bumping `lastActivityAt` for it anymore); no change to the 7-day
    absolute `expiresAt` ceiling itself; no per-request throttling of the
    `lastActivityAt` write (updates on literally every authenticated
    request, per the explicit requirement) — a candidate future
    optimization if write volume ever becomes a concern, not done here.
  - Tests: `proxy.test.ts` gained `lastActivityAt` to every existing
    session mock plus three new cases (bumps `lastActivityAt` on a valid
    request, redirects with `?reason=idle_timeout` past 30 minutes idle,
    does not idle-timeout a session active within 30 minutes) and one
    covering the stale-cookie-cleared-on-/login case; `lib/auth.test.ts`
    and `lib/permissions.test.ts` both gained `lastActivityAt` on their
    session mocks (both would otherwise throw once `getCurrentUser`
    reads it); `app/login/actions.test.ts` gained a regression test
    asserting the cookie carries no `expires`/`maxAge`. Full suite: 839
    passing. `tsc --noEmit` and ESLint are clean. The migration WAS
    applied to and verified against the real dev DB (a genuine
    `prisma migrate dev` run, not simulated); `/login` and `/` were
    confirmed to still compile/serve correctly (200 and a 307 redirect to
    `/login`, `/login?reason=idle_timeout` renders 200) under the
    existing dev server.
  - Not yet visually verified end-to-end in a real browser (closing and
    reopening the browser to confirm re-login is required, and the
    idle-timeout banner's exact appearance) — same
    `next/navigation`-requires-a-real-authenticated-request-shaped
    constraint noted throughout this log for anything needing a real
    logged-in session; see the chat response for the manual testing plan
    handed to the user.

New feature — Custom notification event types + manual/ad-hoc send
  (branch `feature/notification-templates-v2`): see CLAUDE.md's WhatsApp
  Notifications section's new "Custom notification event types + manual
  send" subsection above for the full current-state design — this entry
  is the changelog.
  - **Schema** (migration `20260826150000_notification_templates_v2`):
    `WhatsAppMessageTemplate.eventType` (the fixed `WhatsAppEventType`
    enum) became `eventKey` (a free, unique string) plus new `name`
    (required), `description` (optional), `triggerKind`
    (`WhatsAppTriggerKind`: `AUTOMATIC` | `MANUAL`, default `AUTOMATIC`),
    `isSystem` (`Boolean`, default `false`), and `deletedAt` (soft-delete,
    MANUAL only in practice). `WhatsAppNotificationLog.eventType` became
    `eventKey` (string, no FK — a template can later be deactivated but
    its past deliveries keep their key). The `WhatsAppEventType` enum is
    dropped entirely (nothing references it anymore). Backfilled
    in-place: the 3 pre-existing rows became `eventKey`/`name` = their own
    enum value/label, `isSystem = true`, `triggerKind = AUTOMATIC` — byte-
    identical to before, verified directly against the dev DB after
    applying (including one row that had already been admin-edited before
    this migration, confirming its edited text survived the conversion).
    Also seeds `notification.send.manual` (ADMIN, DEAN, LECTURER — never
    STUDENT), same idempotent guarded-INSERT pattern as every prior
    permission-seed migration.
  - **`lib/whatsapp-templates.ts` rewritten** around the registry:
    `AUTOMATIC_EVENTS` (replacing `WHATSAPP_TEMPLATE_PLACEHOLDERS`/
    `DEFAULT_WHATSAPP_TEMPLATES`/`WHATSAPP_EVENT_TYPE_LABELS`, now keyed
    by string and holding label/description/placeholders/default text
    together per hook), `AUTOMATIC_EVENT_KEYS`, `MANUAL_TEMPLATE_
    PLACEHOLDERS`, `placeholdersFor(triggerKind, eventKey)`,
    `slugifyEventKey(name)`, and `findUnknownPlaceholders`/`fillTemplate`
    updated to the new `(triggerKind, eventKey, text)` signature. Still a
    pure, no-`prisma`-import module — safe for both server code and the
    client Templates/Send-Notification UI.
  - **`lib/whatsapp-notify.ts`**: `getEffectiveTemplate` ->
    `getEffectiveAutomaticTemplate` (AUTOMATIC-only now, by name), cache
    keyed by string `eventKey` and also storing `triggerKind` per entry.
    New exported `sendManualNotification` (the manual-send counterpart to
    the 3 AUTOMATIC notify functions) — reuses the SAME private `enqueue`
    helper and therefore the SAME phone-number/enabled-toggle rules,
    loops recipients without throwing per-row, and returns an
    enqueued/skipped count to its caller (unlike the AUTOMATIC functions,
    which are pure fire-and-forget hooks with no caller waiting on a
    result — this one's caller, the Send Notification action, IS waiting
    and is allowed to report back).
  - **`admin/whatsapp/actions.ts`**: `updateWhatsAppTemplate`/
    `resetWhatsAppTemplate` now key off `eventKey` and validate against
    the row's OWN `triggerKind` (fetched first — the row must already
    exist); `resetWhatsAppTemplate` throws `NO_DEFAULT_TEXT` for a MANUAL
    row. New `createWhatsAppTemplate` (AUTOMATIC: rejects an unregistered
    or already-templated key; MANUAL: slugifies + uniqueness-checks the
    name, rejects a name colliding with a built-in key or an empty slug)
    and `deactivateWhatsAppTemplate`/`reactivateWhatsAppTemplate`
    (MANUAL-only, `SYSTEM_TEMPLATE` guard even though `isSystem` is only
    ever true for AUTOMATIC rows today — defense in depth, not an
    assumption). All four new/changed actions invalidate the template
    cache and audit (`WHATSAPP_TEMPLATE_CREATED`/`_DEACTIVATED`/
    `_REACTIVATED`, alongside the existing `_UPDATED`/`_RESET`).
  - **Templates tab redesigned** (`templates-client.tsx`): two sections
    (Automatic / Manual) instead of a fixed 3-card list; a "Create new
    event type" dialog (trigger-kind picker, an AUTOMATIC hook dropdown
    scoped to unregistered keys only, name/description/template-text
    fields, live placeholder-aware preview); each MANUAL card gains a
    Deactivate/Reactivate button (hidden for AUTOMATIC/system rows); the
    delivery log's event-type filter and column now label by whichever
    template's own `name` matches a log row's `eventKey` (falls back to
    the raw key for a since-hard-deleted row, which can't actually happen
    given soft-delete-only, but kept as a safe fallback) instead of a
    hardcoded 3-item list.
  - **Send Notification** (`admin/notifications/send/` — `recipients.ts`,
    `queries.ts`, `schema.ts`, `actions.ts`, `panel.tsx`,
    `send-notification-client.tsx`, plus thin `page.tsx` routes at
    `/admin`, `/dean`, `/lecturer`): see the CLAUDE.md subsection above
    for the full design. `nav-items.ts` gained a `lecturerHref` field
    (mirroring the existing `deanHref`, since this is the first feature
    shared across all three of ADMIN/DEAN/LECTURER at once) and one new
    "Send Notification" nav entry using both; `app-shell.tsx`'s href
    resolution gained the matching DEAN > LECTURER > default precedence.
    `admin/layout.tsx`/`dean/layout.tsx`/`lecturer/layout.tsx` each gained
    `notification.send.manual` in their section-permission list.
  - Tests: `lib/whatsapp-templates.test.ts` rewritten for the new
    registry-based API (34 cases — AUTOMATIC/MANUAL placeholder
    validation, `slugifyEventKey`, `placeholdersFor`).
    `lib/whatsapp-notify.test.ts` updated for the `eventKey` rename and
    gained a `sendManualNotification` suite (per-recipient fill,
    no-phone/disabled-feature skip-not-fail, className/facultyName
    filling). `admin/whatsapp/actions.test.ts` rewritten/extended (32
    cases — the `eventKey`-keyed update/reset behavior including the
    MANUAL-vs-AUTOMATIC placeholder-set distinction, the full
    `createWhatsAppTemplate` suite for both trigger kinds and every
    rejection reason, deactivate/reactivate including the system-template
    guard). New `admin/notifications/send/actions.test.ts` (18 cases —
    permission gates; ADMIN unscoped for individual/class/faculty sends
    across both recipient kinds; DEAN scoped via the real
    `classDeanWhere`/`studentDeanWhere` where-shapes (partial-mocked
    `lib/dean-scope.ts` keeping the real pure where-builders, only
    `getDeanDepartmentIds` mocked) including the out-of-scope-class and
    out-of-scope-faculty rejections; LECTURER scoped to own assignments
    for both "my course" and individual-student picks, the
    zero-assignments-means-NOT_FOUND-never-everyone case, and the
    never-LECTURER-recipient/never-FACULTY-scope guards; the
    recipient-preview action's count/sample/skip shape). `lib/
    permissions.test.ts` gained `notification.send.manual` coverage and
    the DEAN exact-grant-list pin was updated. Full suite: 891 passing
    (one unrelated pre-existing ExcelJS-cold-start timeout flake in
    `admin/auto-timetable/preview-export.test.ts` when run under full-
    suite parallel load — passes cleanly in isolation, same "one-time
    module-load cost under Vitest" note already on that file from an
    earlier phase). `tsc --noEmit` and a full-repo ESLint pass are clean
    (only the 5 pre-existing, unrelated `react-hooks/incompatible-library`
    warnings on other files' `form.watch()` usage).
  - Verified: the migration was applied to and confirmed against the real
    dev DB (not simulated) — the 3 built-in rows' `eventKey`/`name`/
    `isSystem`/`templateText` (including the one already-edited row)
    inspected directly post-migration, and the new permission's grants to
    ADMIN/DEAN/LECTURER confirmed directly via a Prisma read. `OR: []`'s
    "matches zero rows" semantics (the load-bearing safety property behind
    every LECTURER-tier zero-assignment guard) was verified against the
    real DB with a throwaway count query before relying on it, not assumed
    from memory. `/admin/notifications/send`, `/dean/notifications/send`,
    `/lecturer/notifications/send`, and `/admin/whatsapp` were all
    confirmed to compile and correctly redirect unauthenticated requests
    under a real dev server.
  - Not yet visually verified end-to-end in a real logged-in browser
    session (the compose form's pill-row scope switching, the live
    recipient-count preview, the confirm-and-send dialog, the Templates
    tab's new Create/Deactivate/Reactivate controls) — same
    `next/navigation`-requires-a-real-authenticated-request constraint
    noted throughout this log for anything needing a real session; see
    the chat response for the manual testing plan handed to the user.

New feature — Student Active/Inactive status (branch
  `feature/student-active-status`): see CLAUDE.md's Business rules
  section's new `Student.isActive` bullet above for the full
  current-state design — this entry is the changelog.
  - **Schema**: `Student.isActive Boolean @default(true)` (migration
    `20260827090000_student_is_active`, additive, no backfill needed —
    every existing student defaults to active, unaffected).
  - **`lib/enrollment.ts`**: `autoEnrollStudentIntoClassCourses` now
    fetches the student first and returns `[]` immediately for an
    inactive one, before even looking at course assignments — the one
    choke point every caller (registration, class transfer via
    `admin/enrollments/actions.ts`, student bulk import) goes through.
    `autoEnrollClassIntoAssignment`'s own `tx.student.findMany` gained
    `isActive: true` in its `where` — covers every one of its callers
    (manual Add Assignment, Bulk Assign, Open Semester wizard, Workload
    Import's `finalizeWorkloadImport`) with one change.
  - **`admin/students/actions.ts`**: new `deactivateStudent`/
    `reactivateStudent` (`students.manage`, audited as
    `STUDENT_DEACTIVATED`/`STUDENT_REACTIVATED`) — a plain `isActive`
    flip, nothing else touched (no cascade to `User.isActive`, no
    enrollment changes).
  - **`admin/students/panel.tsx`**: `StudentsSearchParams` gained
    `status` (`"active"` | `"inactive"` | unset-for-all), same
    `useUrlTableState`-driven filter convention as every other status
    filter in this app (Courses, Users, WhatsApp delivery log).
  - **`admin/students/students-client.tsx`**: a Status `Select` filter
    next to the existing Class filter; the table gained a Status column
    (Active/Inactive `Badge`) and a per-row `DropdownMenu` (Deactivate/
    Reactivate) — same `DropdownMenuTrigger render={<Button
    variant="ghost" size="icon-sm" />}` idiom as Rooms/Campuses/Shifts.
  - Tests: `lib/enrollment.test.ts` gained a dedicated
    "never enrolls an inactive student" case for
    `autoEnrollStudentIntoClassCourses` and updated `fakeTx()`'s default
    mock (active by default, so every pre-existing test in that file
    needed no change) plus the `isActive: true` where-clause assertion
    for `autoEnrollClassIntoAssignment`. `admin/students/actions.test.ts`
    gained a `deactivateStudent`/`reactivateStudent` suite (permission
    gate + audit payload for both). Full suite: 903 passing. `tsc
    --noEmit` and ESLint on the touched files are clean.
  - Not yet visually verified end-to-end in a browser — same
    `next/navigation`-requires-a-real-authenticated-request constraint
    noted throughout this log; the migration WAS applied to and verified
    against the real dev DB (a genuine `prisma migrate deploy` run).

Bug fix — new-student registration failing with a generic error right
  after Student Active/Inactive status shipped (branch `main`): a live
  report — registering a brand-new student (a real, previously-unused
  student ID, on a class that genuinely exists) failed every time with
  a plain "Something went wrong. Please try again." toast, no specific
  reason shown.
  - **Investigated and ruled out, with direct evidence, before touching
    any code**: (1) production migration not applied — checked the
    GitHub Actions run for the exact deployed commit via the public
    `api.github.com/repos/.../actions/runs` endpoint (this repo is
    public); the deploy job (which runs `prisma migrate deploy` against
    `.env.production` under `set -euo pipefail`, before restarting
    containers) completed with `conclusion: "success"`, ruling out a
    missing-column mismatch on production. (2) a permission/session
    error — `requirePermission` only ever throws `UNAUTHENTICATED`/
    `FORBIDDEN`, both of which `lib/action-error.ts` translates to a
    SPECIFIC toast, not the generic fallback — so neither fired. (3) a
    form/validation bug — the exact reported input (gender, phone,
    class) was replicated against a real Prisma-connected DB inside a
    deliberately-rolled-back transaction (mirroring `registerStudent`'s
    real body byte for byte) and completed with zero errors.
  - **Root cause**: `registerStudent`'s `prisma.$transaction(...)` call
    had no explicit timeout margin (Prisma's tight defaults: 5s timeout,
    2s `maxWait`). The Student Active/Inactive feature added a genuinely
    NEW round-trip inside it — `autoEnrollStudentIntoClassCourses` now
    does a `tx.student.findUnique` (the isActive guard) before its
    existing queries — tipping a previously-fast-enough transaction into
    the exact "Transaction already closed"/timeout failure class this
    codebase has hit and fixed TWICE before on Neon's pooled
    `DATABASE_URL` connection (see the transaction-timeout convention
    above) — an unrecognized raw Prisma error, re-thrown as-is since
    `registerStudent`'s catch only special-cases `P2002`, landing on the
    client as the generic fallback. A second call site was found with
    the identical new exposure: `transferEnrollment`
    (`admin/enrollments/actions.ts`, class transfer) also calls
    `autoEnrollStudentIntoClassCourses` inside an equally un-margined
    `$transaction`. Both had ZERO existing test coverage before this fix
    — a real gap that let this ship unnoticed.
  - **Fix**: both transactions now pass the existing
    `BULK_TRANSACTION_OPTIONS` (`lib/db.ts`) as their second argument,
    the same established, already-proven pattern used by every other
    interactive transaction in this codebase that carries this risk —
    no new constant, no bespoke per-site tuning, per the existing
    convention. Both call sites are single-row (not a batch loop), which
    is why they were correctly excluded from the original transaction-
    timeout audit — the margin is applied here specifically because the
    isActive feature changed their risk profile by adding the extra
    round-trip, documented inline at both call sites.
  - New tests (neither function had any before): `admin/students/
    actions.test.ts` gained a `registerStudent` suite (permission gate,
    create + auto-enroll + both audits, P2002 -> `STUDENT_NO_TAKEN`, and
    the `BULK_TRANSACTION_OPTIONS` assertion) with the file's `@/lib/db`
    mock extended to a real `$transaction`/`tx.student.create` shape and
    a new `@/lib/enrollment` mock. `admin/enrollments/actions.test.ts`
    gained a `transferEnrollment` suite (NOT_ACTIVE guard, the full
    demote-old/create-new/move-student/auto-enroll sequence, permission
    gate, and the same `BULK_TRANSACTION_OPTIONS` assertion), same mock
    extension pattern. Full suite: 912 passing (9 new). `tsc --noEmit`
    and ESLint on the touched files are clean.
  - Diagnosis was performed with a temporary, read-only-in-intent
    reproduction script (a real `$transaction` running `registerStudent`'s
    exact body against a live DB, forced to roll back at the end via a
    deliberate thrown error, with a post-rollback existence check
    confirming nothing was persisted) — deleted immediately after use,
    never committed.

New feature — "Move semester" bulk action on Course Plans (branch
  `main`): see the "ClassCoursePlan is a reusable curriculum template"
  business rule above for the full current-state description — this entry
  is the changelog. Re-points EVERY `ClassCoursePlan` row for one class at
  a source `semesterNumber` (1..8 batch level, NOT the academic-calendar
  Semester's 1/2) to a target `semesterNumber` in one action — the
  "bulk-fix a data-entry mistake" case (entered the whole plan under the
  wrong level).
  - **`app/(app)/admin/course-plans/actions.ts`**: two new Server
    Actions, both gated on `curriculum.manage` (same key as every other
    action in this file — no new permission), input validated with a
    shared `moveSemesterPlanSchema` Zod object (`classId`, `sourceSemesterNumber`
    /`targetSemesterNumber` each `int().min(1).max(8)`).
    `previewMoveSemesterPlan` (read-only) returns
    `MoveSemesterPlanPreview` — the source course list, the target
    level's current course count, the exact source courses already
    present at the target (`duplicateCourseNames`, skipped on move),
    `movingCount`, and the downstream-impact counts: `assignmentCount`
    (existing `LecturerCourseAssignment` rows for THIS class referencing
    any moved course) + `timetableSlotCount` (`TimetableSlot`s hanging
    off those). `moveSemesterPlan` re-fetches source/target fresh
    (never trusts the preview), throws `SAME_SEMESTER` /
    `NO_COURSES_AT_SOURCE` as guards, then in ONE
    `prisma.$transaction([...])` does a `deleteMany` of the duplicate
    source rows (a source course already at the target can't have its
    `semesterNumber` updated — collides with the existing target row on
    `@@unique([classId, semesterNumber, courseId])`) + an `updateMany`
    of the rest to the target level. Two bounded statements regardless of
    plan size (no per-row loop), so `BULK_TRANSACTION_OPTIONS` is
    deliberately NOT used — same reasoning as every other bounded
    transaction in this app. Audited via `lib/audit.ts` as
    `COURSE_PLAN_SEMESTER_MOVED` (entity `Class`, `oldValue` =
    source level + course count, `newValue` = target level +
    moved/skipped counts + moved course names, `userId` = the admin).
    Assignments/timetable slots are NEVER modified — they key on the
    academic-calendar `semesterId`, not `semesterNumber` — which is
    exactly why the preview surfaces a warning count for the admin to
    reconcile those separately rather than the action silently leaving
    them stale.
  - **`app/(app)/admin/course-plans/move-semester-dialog.tsx`** (new
    client component, mirrors `admin/classes/bulk-period-dialog.tsx`'s
    "separate dialog file importing `type` from `./actions`" pattern): a
    "Move semester" button on the Course Plans page (next to "Copy plan
    from another class") opens it. From-semester picker (defaults to the
    page's currently-selected level), to-semester picker (source level
    excluded from its options; changing the source resets the target). A
    `useEffect` re-fetches `previewMoveSemesterPlan` whenever both are
    chosen and differ, with a `cancelled` guard against a stale
    response; stale preview is cleared in the picker `onValueChange`
    handlers (events, not the effect) so nothing is set synchronously in
    the effect body except the single documented `loadPreview` call
    (same `eslint-disable react-hooks/set-state-in-effect` pattern as
    `auto-timetable-generator-client.tsx`). The dialog shows the source
    course list, an empty-source "nothing to move" state, the
    merge/duplicate-skip breakdown against the target level, and the
    amber downstream-assignment warning. On confirm it toasts
    "Moved N courses to Semester Y — K duplicates … skipped", navigates
    the page to the target level, and `router.refresh()`es.
  - Tests: `app/(app)/admin/course-plans/actions.test.ts` gained a
    `previewMoveSemesterPlan` suite (SAME_SEMESTER guard, the full
    preview shape incl. the `{ in: [...] }` where-clauses on both
    downstream `count` calls, and the "source level empty -> skip the
    count queries entirely" case) and a `moveSemesterPlan` suite
    (permission-key check, SAME_SEMESTER/NO_COURSES_AT_SOURCE guards,
    the delete-duplicates + update-the-rest happy path with exact
    `deleteMany`/`updateMany` args, the target-empty no-delete case, the
    all-duplicates no-update case, and the exact
    `COURSE_PLAN_SEMESTER_MOVED` audit payload). The `@/lib/db` mock
    gained `classCoursePlan.deleteMany`/`updateMany`,
    `lecturerCourseAssignment.count`, `timetableSlot.count`, and a new
    `@/lib/audit` mock. Full suite: 922 passing (10 new). `tsc --noEmit`
    and ESLint on the touched files are clean.
  - Not visually verified end-to-end in a browser — same
    `next/navigation`-requires-a-real-authenticated-request constraint
    noted throughout this log; the pure action logic + the audit/
    transaction shape are covered by the new tests.

Display change — Classes table gets server-side filtering + pagination
  (branch `main`): the Academic Structure > Classes tab table was
  converted from a render-everything list to the shared server-paginated
  table toolkit (`lib/pagination.ts` + `lib/use-url-table-state.ts` +
  `TablePagination`/`TableSearchInput`), same pattern as Students/
  Enrollments/Users/Audit Logs — see the "Table conventions" bullet above
  (Classes moved from the "NOT converted" list to "Server-paginated so
  far"). Filters (all URL-synced, all ANDed, page resets to 1 on any
  filter/search change): free-text search on `name`/`batchCode`/`section`,
  Program (`SearchableSelect`, `programId`), Mode (`studyMode` FT/PT),
  Period (`period` MORNING/AFTERNOON), Semester (`currentSemesterNumber`
  1..8), Status (active = `deletedAt: null` / inactive = `{ not: null }`;
  default unset = both, unchanged from before). The `Select`-based
  filters use the `"all"` sentinel + `value === "all" ? "" : value`
  translation the convention documents; Program passes `""` straight
  through.
  - `admin/classes/panel.tsx` now takes `searchParams` (widened
    `ClassesSearchParams` interface), builds a `Prisma.ClassWhereInput`,
    and `findMany({ where, skip, take })` + `count({ where })`. It ALSO
    fetches `allClasses` (every class, `include: { program: true }`,
    unfiltered) — the "Bulk update period" dialog does its own
    client-side FT/active filtering over the whole set and can't work off
    just the visible page — and resolves the `editClassId` deep-link
    target via a direct `findUnique` (with the `program`/`room.campus`
    includes the edit form needs), since that class may be filtered out
    or on another page. `admin/structure/page.tsx` widened its
    `searchParams` type and passes the whole param object through to
    `ClassesPanel`.
  - `admin/classes/classes-client.tsx`: `editClassId?: string` prop
    replaced by `editClass: ClassWithProgram | null` (server-resolved
    row, not an id looked up in the page's own rows); new `allClasses`,
    `total`, `page`, `pageSize` props; `useUrlTableState` wired to a
    filter row above the table and a `TablePagination` inside the table
    border. `BulkPeriodDialog` now receives `allClasses`. Empty state
    distinguishes "No classes yet" (`allClasses.length === 0`) from "No
    classes match these filters".
  - No schema change, no new permission, no action change — `createClass`
    /`updateClass`/`deactivate`/`reactivate` and their tests are
    untouched. No new test file (this is a display-only change and the
    codebase has no `.tsx`/panel unit tests); `tsc --noEmit`, ESLint
    (only the pre-existing `react-hooks/incompatible-library`
    `form.watch()` warning on this file, not introduced here), and the
    full Vitest suite (922 passing, unchanged) are clean.
    `/admin/structure?tab=classes` (plain and with
    `mode`/`status`/`page`/`pageSize` params) compiles and serves a clean
    auth redirect under a real dev server.
  - Not visually verified end-to-end in a browser — same
    `next/navigation`-requires-a-real-authenticated-request constraint
    noted throughout this log.

New feature — Daily Log leave notices link real timetable sessions;
  leave hours are computed from scheduled session durations, snapshotted
  (branch `main`): see the Faculty Daily Log business rule's new "Leave
  hours are computed from linked timetable sessions at logging time"
  bullet above for the full current-state description — this entry is the
  changelog. Before starting: verified against the code that NO
  "total-hours summary" existed on the "My Leave Notices" widget yet (the
  request's "added in the last change" premise was false — the widget was
  a plain Date/Faculty/Note/Logged-by table), so the summary is built
  fresh here, not "updated".
  - **Schema** (migration `20260830230016_daily_log_leave_sessions`,
    applied to the dev DB via a real `prisma migrate dev`):
    `DailyLogEntry.leaveHours Decimal?(5,2)` — the snapshot total, null
    for note-only / NOTE / PROBLEM entries. New `DailyLogEntrySession`
    join table: `dailyLogEntryId` (Cascade), nullable `timetableSlotId`
    (`SetNull` on slot delete — never Cascade, so historical leave detail
    survives a timetable edit), plus per-session SNAPSHOT columns
    `courseName`/`className`/`startTime`/`endTime`/`hours Decimal(5,2)`.
    `TimetableSlot` gained the inverse `dailyLogEntrySessions` relation.
  - **`lib/leave-hours.ts`** (new, pure, unit-tested in
    `lib/leave-hours.test.ts`): `sessionDurationHours(start, end)`
    (span in hours, never negative — reuses `timeToMinutes` from
    `lib/timetable-conflicts.ts`, the one HH:MM parser), `sumSessionHours`
    (sum + 2dp round so `1.5+1.5 = 3`), `formatLeaveHours`
    ("12.5 hours"/"1 hour"), `dayOfWeekFromISODate` (a "YYYY-MM-DD"
    string -> the schema `DayOfWeek` enum via `getUTCDay`, tz-independent).
    Duration comes from the slot's OWN `startTime`/`endTime` (not a
    `Shift` lookup — `TimetableSlot` has no FK to `Shift`, and the slot's
    stored times are its real length regardless of where they came from).
  - **`admin/daily-log/queries.ts`**: `fetchLeaveSessionSlots({lecturerId
    |studentId, entryDate})` — the ONE resolver of "which sessions could
    this leave cover" (lecturer: every session they teach that day;
    student: their class's sessions that day, via `Student.classId`; both
    scoped to the active `Semester`), shared by the form preview AND the
    create re-validation so they can't diverge. `toLeaveNoticeSessionOptions`
    maps slots to `{course, class, time, hours}`. `getDailyLogEntries` /
    `getMyLeaveNotices` / `getMyLeaveNoticesForStudent` now `include`
    `sessions` and serialize `leaveHours` + each `session.hours` from
    Decimal to number (`serializeDailyLogEntry`/`serializeSessions`, per
    `lib/serialize.ts`'s established Decimal-across-the-boundary rule).
    New `getMyLeaveHoursSummary(userId, {forStudent})` —
    `prisma.aggregate({_sum: {leaveHours}})` over ALL the person's leave
    notices in the active semester's date range (falls back to all-time
    when there's no active semester), for the widget's "N hours of leave
    this semester" line (the widget lists 5, totals every one).
  - **`admin/daily-log/actions.ts`**: new `getLeaveNoticeSessions`
    action (same `dailylog.create` gate) for the form's live lookup.
    `createDailyLogEntry` gained a `sessionIds` input
    (`z.array(z.string()).optional()` — never `.optional().default([])`,
    which breaks zodResolver generics); for a LEAVE_NOTICE it re-resolves
    those ids through `fetchLeaveSessionSlots` (drops anything not a real
    session for that person/day), computes `leaveHours` as the summed
    span, and writes the entry + `DailyLogEntrySession` rows in one
    `$transaction` — ONLY when there are session rows; the common
    note/problem path stays a plain single `create` (which is why every
    pre-existing NOTE test in `actions.test.ts` passed unchanged).
    `DAILYLOG_CREATED` audit `newValue` gained `leaveHours` +
    `sessionCount`.
  - **`admin/daily-log/daily-log-client.tsx`**: below the Date field, for
    a LEAVE_NOTICE with a person + date, a `useEffect` calls
    `getLeaveNoticeSessions` (cancel-guarded against a stale response,
    `eslint-disable react-hooks/exhaustive-deps` for the stable `form`
    ref) and renders a "Select all" + per-session checkbox list with a
    live `formatLeaveHours` total; a day with no sessions shows the
    "will be logged as a note-only leave entry (no hours)" fallback text.
    The list table's Title cell gained a "{hours} — {course} {time} · …"
    line for LEAVE_NOTICE entries with `leaveHours != null`.
  - **`app/(app)/page.tsx`** (Lecturer dashboard) + **`app/(app)/student/
    page.tsx`**: the "My Leave Notices" widget gained a header
    "{N} hours of leave this semester" line (from `getMyLeaveHoursSummary`,
    only shown when > 0) and Sessions/Note + Hours columns replacing the
    bare Note column.
  - Tests: `lib/leave-hours.test.ts` (new — every pure helper incl. the
    negative-range and float-drift cases, the tz-independent
    date->DayOfWeek mapping). `admin/daily-log/queries.test.ts` extended
    (Decimal->number serialization of a linked session's hours + the
    entry's `leaveHours`; `fetchLeaveSessionSlots` lecturer/student
    day+active-semester where-shapes and the missing-date / unresolved-
    student short-circuits; `toLeaveNoticeSessionOptions` duration math;
    `getMyLeaveHoursSummary` active-semester-scoped vs all-time fallback).
    `admin/daily-log/actions.test.ts` extended (server-side slot
    re-resolution + snapshot + summed `leaveHours`; a bogus submitted
    slot id dropped; the no-sessions plain-create fallback with
    `leaveHours: null`; `sessionIds` ignored for a NOTE). Full suite:
    943 passing (was 922). `tsc --noEmit` and ESLint clean (only the
    pre-existing `react-hooks/incompatible-library` `form.watch()`
    warning). `/admin/daily-log`, `/dean/daily-log`, `/`, `/student` all
    compile and serve a clean auth redirect under a real dev server.
  - Not visually verified end-to-end in a browser — same
    `next/navigation`-requires-a-real-authenticated-request constraint
    noted throughout this log.
  - Follow-up fix: the Add-entry dialog got tall enough (Type + About +
    Date + the new "Sessions covered" list + Note) to overflow the
    viewport with no way to scroll to Save. Scoped fix on the daily-log
    `DialogContent` only (`max-h-[90dvh] overflow-y-auto`) — NOT the
    shared `components/ui/dialog.tsx`, whose absolutely-positioned close
    button would scroll away from ~20 other dialogs — plus a
    `max-h-52 overflow-y-auto` cap on the session list itself so a
    lecturer with many sessions scrolls that list internally rather than
    ballooning the dialog.

New feature — "Send credentials" over WhatsApp for lecturer accounts,
  with sent-password flagging (branch `main`): see the WhatsApp
  Notifications section's new "Lecturer login credentials" bullet above
  for the full current-state design — this entry is the changelog.
  - **Schema** (migration `20260831120000_lecturer_credentials_send`,
    additive, applied to the dev DB via `prisma migrate deploy`):
    `User.passwordSentAt DateTime?` (mark-as-used flag for the current
    temp password, cleared on every reset) and
    `WhatsAppSettings.domainName String?` (the configurable `{domainName}`
    shown in the message). The migration also seeds one new
    `whatsapp_message_templates` row, `LECTURER_LOGIN_CREDENTIALS`
    (`trigger_kind = AUTOMATIC`, `is_system = true`), with the exact
    Somali message text via a `$creds$…$creds$` dollar-quoted literal —
    verified byte-identical (529 chars) to
    `LECTURER_LOGIN_CREDENTIALS_DEFAULT` in `lib/whatsapp-templates.ts`
    and clean against its own 6-placeholder set.
  - **`lib/whatsapp-templates.ts`**: new `LECTURER_LOGIN_CREDENTIALS`
    entry in `AUTOMATIC_EVENTS` (placeholders `academicYear`,
    `semesterName`, `domainName`, `username`, `tempPassword`,
    `facultyName`). Registered as AUTOMATIC — not MANUAL — specifically
    because MANUAL templates are locked to the one shared
    `MANUAL_TEMPLATE_PLACEHOLDERS` set and are sent only via the generic
    Send Notification compose form; this event needs its own
    credential-specific placeholder set, a coded default to reset to, and
    a dedicated trigger point. It IS sent by an explicit admin click,
    not a passive hook, but the CLAUDE.md rule ("a new automatic type
    starts with a real code change: a new notify function + an
    `AUTOMATIC_EVENTS` entry, THEN a template row") is satisfied exactly.
  - **`lib/whatsapp-notify.ts`**: new `sendLecturerCredentials(params)`
    — like `sendManualNotification`, it's called from a Server Action
    the admin waits on, so it returns `{ enqueued }` and never throws;
    resolves the template through the same
    `getEffectiveAutomaticTemplate` cache + fallback and enqueues via the
    same `enqueue` helper (phone-number / `enabled` toggle fully
    respected).
  - **`admin/whatsapp/actions.ts`**: new `setWhatsAppDomain(domain)`
    (`whatsapp.manage`, audited `WHATSAPP_DOMAIN_UPDATED`, trims / clears
    to null). `whatsapp-client.tsx` gained a "Login domain" card
    (input + Save) above the Tabs.
  - **`admin/lecturer-accounts/actions.ts`**: `sendLecturerCredentials`
    (single) and `sendLecturerCredentialsBatch` ("Send all"), both
    `user.manage`. Resolve `{facultyName}` from `Lecturer.departmentId`
    first, else any assigned class's `program.department`, else blank;
    `{academicYear}`/`{semesterName}` from the active `Semester` +
    `academicYear`; `{domainName}` from settings (throws
    `DOMAIN_NOT_CONFIGURED` if unset). The temp password is passed from
    the client (the admin's still-open results dialog) — never persisted
    in plaintext, consistent with the existing print/CSV flow.
    `passwordSentAt` is stamped only when the row is actually enqueued;
    `LECTURER_CREDENTIALS_SENT` audited per lecturer. Guard:
    `mustChangePw === false` -> hard `PASSWORD_CHANGED` (force does not
    override); `passwordSentAt` set + not `force` -> soft `ALREADY_SENT`
    (force overrides). `resetLecturerPassword` now also sets
    `passwordSentAt: null`.
  - **`admin/lecturer-accounts/lecturer-accounts-client.tsx`**: a
    per-row "Send credentials" cell (idle -> "Send credentials"; after
    send -> "Sent ✓ · Resend"; `ALREADY_SENT` -> amber "Already sent —
    Resend anyway" behind a `window.confirm`; `PASSWORD_CHANGED` -> amber
    "use Reset Password", no resend) in both the batch and single results
    dialogs, plus a "Send all credentials" button. Disabled with a hint
    when WhatsApp is off or the domain is unset (`panel.tsx` now also
    fetches `WhatsAppSettings`). The main lecturer list shows a subtle
    "· credentials sent" note next to an account's status when
    `passwordSentAt` is set.
  - Tests: `lib/whatsapp-templates.test.ts` (registry now has 4 keys;
    `LECTURER_LOGIN_CREDENTIALS` placeholder set); `lib/whatsapp-notify.test.ts`
    (`sendLecturerCredentials` fills the seeded template, no leftover
    tokens, `enqueued:false` on no-phone / disabled);
    `admin/whatsapp/actions.test.ts` (`setWhatsAppDomain` permission /
    trim / clear / audit); `admin/lecturer-accounts/actions.test.ts`
    (permission gate, `DOMAIN_NOT_CONFIGURED`, happy path fills + stamps
    + audits, `ALREADY_SENT` soft-block then force, `PASSWORD_CHANGED`
    hard-block, no-flag-when-not-enqueued, faculty fallback to a class's
    program department, batch per-lecturer status collection,
    reset clears `passwordSentAt`). Full suite green (963 passing; the
    one unrelated ExcelJS cold-start flake in
    `admin/auto-timetable/preview-export.test.ts` passes in isolation, as
    already noted in this log). `tsc --noEmit` and ESLint clean.
  - Not visually verified end-to-end in a browser — same
    `next/navigation`-requires-a-real-authenticated-request constraint
    noted throughout this log; the migration WAS applied to and verified
    against the real dev DB (seeded row inspected directly, byte-match
    confirmed).

Follow-up — persistent "Send credentials" entry point on the Lecturer
  Accounts table (branch `main`): the "Send credentials" action was only
  reachable inside the transient post-generation results popup; once
  closed, the only way to (re)send was `resetLecturerPassword`, which
  needlessly invalidates a still-unused temp password. Added an
  always-reachable entry point on the main table — same underlying
  send/block/resend logic, just triggerable anytime (same spirit as the
  workload-import pending-auto-generate card fix).
  - **Schema** (migration `20260831140000_lecturer_pending_credential`,
    additive): `User.pendingCredential TEXT` — AES-256-GCM ciphertext of
    the account's current admin-issued temp password. New
    `lib/credential-crypto.ts` (`encryptCredential`/`decryptCredential`/
    `credentialStoreConfigured`, key from `CREDENTIAL_ENCRYPTION_KEY`,
    64-hex or base64, no-op returning null when unset). This is the ONE
    documented exception to "temp passwords never persisted" — never
    plaintext, decrypted server-side only, wiped on the lecturer's
    `changePassword` and on `resetUserPassword`/`resetLecturerPassword`.
  - **`admin/lecturer-accounts/actions.ts`**: generate + reset now also
    write `pendingCredential: encryptCredential(tempPassword)`.
    `sendLecturerCredentials`' `tempPassword` is now optional — omitted
    from the table, where the server resolves it from the decrypted
    stored credential (`resolveTempPassword`); `NO_STORED_CREDENTIAL`
    when neither is available. `sendLecturerCredentialsBatch` items'
    `tempPassword` likewise optional (new `no_stored_credential` status).
    Block rules unchanged: `mustChangePw === false` -> hard
    `password_changed` (force can't override); `passwordSentAt` + !force
    -> soft `already_sent`.
  - **`admin/lecturer-accounts/panel.tsx`**: passes a ciphertext-free row
    shape (`hasStoredCredential: boolean`, never the blob) +
    `credentialStoreReady` (from `credentialStoreConfigured()`).
  - **`lecturer-accounts-client.tsx`**: per-row "Send credentials" in the
    main table's action cell (base state derived from the row's
    `mustChangePw`/`passwordSentAt`; "Reset password to send" when no
    stored credential; "Send unavailable" when the key isn't configured),
    plus a "Send credentials to all eligible (N)" bulk button above the
    table (targets `mustChangePw && !passwordSentAt && hasStoredCredential`;
    sends lecturerId-only items, server decrypts each). `router.refresh()`
    after a table send so `passwordSentAt` / the "· credentials sent"
    note update. Resend-confirm copy softened (the SAME still-valid
    credential can now legitimately be re-sent).
  - **`change-password/actions.ts`** and **`admin/users/actions.ts`
    `resetUserPassword`**: also set `pendingCredential: null`.
  - **`.env.production.template`**: documented `CREDENTIAL_ENCRYPTION_KEY`
    (optional — feature degrades gracefully without it).
  - Tests: new `lib/credential-crypto.test.ts` (round-trip, random IV,
    tamper/junk/wrong-key -> null, no-key no-op, key-format validation).
    `admin/lecturer-accounts/actions.test.ts` gained: generate/reset
    write an encrypted `pendingCredential`; `sendLecturerCredentials`
    uses the decrypted stored credential when the caller supplies none;
    `NO_STORED_CREDENTIAL` when neither is available; batch resolves each
    row's stored credential for lecturerId-only items.
    `change-password`/`admin/users` reset tests updated for the
    `pendingCredential: null` clear. Full suite 974 passing; `tsc` +
    ESLint clean. Migration applied to the dev DB.
  - Not visually verified end-to-end in a browser (same
    `next/navigation`-needs-a-real-session constraint noted throughout).

Change — Timetable "super filter" report view is now a GRID, not a flat
  card list (branch `main`): the admin/dean Timetable view's Now/Day/Shift/
  Full-week filtered result set now renders as Shift-rows x Day-columns
  grids — the SAME `components/timetable/schedule-grid.tsx` (`ScheduleGrid`)
  the Build Timetable drag-and-drop tool uses, in read-only mode
  (`interactive={false}`: no drag targets, no draggable chips), instead of
  a second grid implementation. Every existing filter (Class/Lecturer/
  Room/Campus/Day + the Now/shift/Full-week quick-select) is unchanged —
  it just determines WHICH grid(s) render and which cells populate.
  - **Multi-class handling (decided): one grid per (studyMode, period)
    "structure group".** The grid's day COLUMNS come from
    `VALID_DAYS_BY_STUDY_MODE[studyMode]` and its shift ROWS from the
    shifts for that studyMode (+ period for FT), so two classes can only
    share a grid's axes when they share that structure. Classes that DO
    share it are combined into ONE grid (each card shows its class label)
    — the more useful "everything on in this shift right now, across the
    faculty" view, and it avoids a wall of near-identical single-row
    grids. Different structure -> its own grid, stacked (like the
    auto-generate multi-class overview). A single matching class is
    trivially one grid; legacy classes with no studyMode fall into an
    "Unspecified" group over `ALL_DAYS_ORDER`.
  - **New pure module `admin/timetable/now-grid.ts`** (`buildNowGrids` +
    `rowIdForSession`, DB-free, unit-tested) does the grouping/row/day
    layout — shared by the client (renders each group with
    `<ScheduleGrid>`) and the server (`exportTimetable` emits one sheet
    per group in the same shape), so the on-screen grid and its Excel
    export can never disagree. When a structure group has no matching
    Shift template, rows are synthesized from the sessions' own distinct
    time ranges so the grid still renders.
  - **`ScheduleGrid` additions**: `ScheduleGridSession.status?` ("NOW" |
    "NEXT") -> a badge + green/`primary` accent WITHIN the session's cell
    (replacing the old flat-list top badges); `.className?` -> a muted
    class-label line, shown only when a grid combines >1 class; optional
    `onEditSession`/`onDeleteSession` -> a small ⋯ Edit/Delete menu on
    each full-scale card even when `interactive={false}` (reopens the
    pre-existing single-slot Add/Edit dialog / delete flow — this view
    is read-only in the drag-and-drop sense, but per-slot edit/delete is
    preserved, not silently dropped). Compact/`CompactSessionChip` also
    pick up the NOW accent. No behavior change for the interactive
    builder / auto-generate preview (they never set `status`/`className`
    /`onEditSession`).
  - **Excel export** (`exportTimetable`, `admin/timetable/actions.ts`):
    rewritten from a flat 10-column table to one grid-shaped sheet per
    structure group — row 1 = `["Shift", ...dayHeaders]`, one row per
    shift, each cell = the joined `"HH:MM–HH:MM  Course — Lecturer
    (Room — Campus) [NOW|NEXT]"` for sessions in that (shift, day). Same
    three-branch Now/Shift/Full-week + Day resolution and same
    `getSlotsForExport` scope query as before. No matching sessions ->
    one header-only `"Shift"` sheet, still never throws. (Still Excel
    only — no PDF export was ever built for this view.)
  - **`now-view-client.tsx`**: the flat `SessionCard` list is gone;
    renders `gridGroups.map(...)` with a `<ScheduleGrid interactive={false}>`
    per group (a group heading shown only when there's >1 group). The
    quick-select bar, filter row, header/count line, "no shift templates"
    banner and empty state are unchanged.
  - Tests: new `admin/timetable/now-grid.test.ts` (grouping/ordering,
    combined-grid class labels, real-vs-synthesized rows, day resolution
    per studyMode, `rowIdForSession`); `admin/timetable/actions.test.ts`'s
    `exportTimetable` suite rewritten for the grid-sheet shape (per-group
    sheets, NOW/NEXT markers, Day-wins-over-now, shift windows, the
    FT/PT split into separate sheets, header-only empty/unassigned-dean).
    Full suite green (983 passing + the one pre-existing unrelated
    ExcelJS cold-start flake that passes in isolation); `tsc` + ESLint
    clean.
  - Not visually verified end-to-end in a browser — same
    `next/navigation`-needs-a-real-authenticated-request constraint noted
    throughout this log; the grid layout, NOW/NEXT highlighting, and
    export shape were verified via unit tests against real `XLSX.read`
    round-trips.

Change — Timetable WhatsApp notifications are MANUAL, per-batch, and
  rate-limited to one message per 5 seconds (branch `main`): the automatic
  "every timetable slot edit fans out a WhatsApp to the class" behavior is
  gone — see the WhatsApp Notifications section's "Trigger points" bullet
  above for the full current-state design; this entry is the changelog.
  - **Removed the automatic trigger**: `createTimetableSlot`/
    `updateTimetableSlot`/`deleteTimetableSlot`/`clearClassTimetable`
    (`admin/timetable/actions.ts`) and `confirmAutoTimetableBatch`/
    `clearSemesterLevelTimetable` (`admin/auto-timetable/actions.ts`) no
    longer call any notify hook at all. `lib/whatsapp-notify.ts`'s
    `notifyTimetableChange` (student-only, per-class, fire-and-forget) was
    deleted and replaced by `sendTimetableNotifications({recipients,
    changeSummary})` — recipient list resolved by the CALLER (like
    `sendManualNotification`), covers students AND lecturers, returns
    `{enqueuedStudents, enqueuedLecturers, skipped}`, still never throws
    per recipient.
  - **Added "Send timetable notifications"** in two places (both funnel
    into `sendTimetableNotifications`; recipient resolution is the one
    shared `resolveTimetableNotificationRecipients` in
    `admin/timetable/queries.ts`):
    1. **Per semester-number batch** — `SendTimetableNotificationsCard`
       on the Workload Import & Auto-Timetable panel
       (`admin/auto-timetable/send-timetable-notifications-card.tsx`),
       sibling to `ClearSemesterTimetableCard`, gated on
       `timetable.generate`. Chosen as the primary home: it's exactly the
       per-batch scope the request names, it's persistent (survives
       reload, always reachable), and it mirrors the existing "Clear
       timetable for a semester level" card precisely — the two are the
       natural bookends of preparing a batch's timetable.
       `previewSendTimetableBatchNotifications` / `sendTimetableBatchNotifications`
       in `admin/auto-timetable/actions.ts`.
    2. **Per class** — `SendClassTimetableNotificationsButton` next to
       "Clear timetable" on the drag-and-drop Timetable Builder
       (`admin/timetable/build-timetable-client.tsx`), gated on
       `timetable.manage`, scoped to the currently-picked class +
       semester. `previewClassTimetableNotifications` /
       `sendClassTimetableNotifications` in `admin/timetable/actions.ts`.
    Recipients = every `Student` with `isActive: true` in the affected
    class(es) + every lecturer with a `TimetableSlot` in that
    class+semester (deduped, `{className}` = comma-joined list for a
    multi-class lecturer). Dean-scoped via `classDeanWhere` on the class
    lookup. Audited as `TIMETABLE_NOTIFICATIONS_SENT` (one entry per
    click).
  - **Rate limiting**: `whatsapp-service/src/index.ts`'s
    `INTER_MESSAGE_DELAY_MS` raised 1500 -> 5000 (env-overridable) — the
    worker already `sleep()`s that long between each individual send, so
    the queue now drains at one message / 5s regardless of how many rows
    one click enqueued (100 recipients ≈ 8 min). Also added a
    `batchInFlight` guard around `pollAndSend` so overlapping `setInterval`
    ticks can't run batches in parallel (which, at 5s spacing, would
    otherwise re-fetch the same PENDING rows and both double-send and
    defeat the pacing). `.env.example` documents the new var.
  - **Progress/expectation**: the confirm dialog shows student/lecturer/
    with-phone counts, a per-class breakdown, and an estimated wall-clock
    time (`~ceil(withPhoneCount * 5 / 60)` min); the success toast reads
    "Notifications queued for X students and Y lecturers — sending
    gradually (about one every 5 seconds, ~M min). Check the Delivery
    Log." A disabled-feature / zero-phone send toasts a clear no-op
    message instead of a false success.
  - **Duplicate-send guard**: `getRecentTimetableSend(classIds)`
    (`lib/whatsapp-notify.ts`) finds the latest `TIMETABLE_CHANGE` log
    row for those classes in 24h + the still-`PENDING` count. The preview
    surfaces an amber "already queued at [time] ([N] still sending) —
    resend anyway?" banner and the button becomes "Resend anyway"
    (passes `force: true`); the send action independently re-checks and
    throws `RECENTLY_SENT` within `TIMETABLE_RESEND_GUARD_MS` (10 min)
    unless forced (`lib/action-error.ts` maps it to a clear message; the
    client re-fetches the preview so the warning shows).
  - **Other WhatsApp triggers unchanged**: `RESULTS_PUBLISHED`,
    `LEAVE_NOTICE`, `LECTURER_LOGIN_CREDENTIALS`, and the generic manual
    Send Notification flow are all untouched. The `TIMETABLE_CHANGE`
    template row itself is reused (its allowed placeholder set just
    gained `{recipientName}` alongside `{studentName}`, both filled with
    the recipient's own name — a backward-compatible code-only change, no
    migration, no schema change anywhere in this whole change).
  - Tests: `lib/whatsapp-notify.test.ts` — `notifyTimetableChange` suite
    replaced with `sendTimetableNotifications` (per-recipient fan-out,
    both name tokens filled, disabled-feature no-op) + a
    `getRecentTimetableSend` suite (latest-row/pending-count query shape,
    empty-list short-circuit, never-throws). `admin/timetable/actions.test.ts`
    and `admin/auto-timetable/actions.test.ts` — the `notifyTimetableChange`
    assertions became "does NOT send automatically" assertions; new
    describe blocks for `previewClassTimetableNotifications`/
    `sendClassTimetableNotifications` and
    `previewSendTimetableBatchNotifications`/`sendTimetableBatchNotifications`
    (permission gate, dean-scoping, count shape, fan-out to
    `sendTimetableNotifications`, `TIMETABLE_NOTIFICATIONS_SENT` audit,
    the `RECENTLY_SENT` guard + `force` override, no-op when no class has
    a built timetable). Full affected suites green (128 tests across the
    three files); `tsc --noEmit`, ESLint on the changed files, and the
    worker's own `tsc --noEmit` all clean.
  - Not visually verified end-to-end in a browser — same
    `next/navigation`-needs-a-real-authenticated-request constraint noted
    throughout this log.

New feature — "Timetable Ready" WhatsApp notification (branch `main`): a
  LECTURER-ONLY, manual, per-lecturer (or bulk-with-pacing) WhatsApp
  telling a lecturer their timetable for a semester is ready to view —
  fully independent of "Lecturer Login Credentials". See the WhatsApp
  Notifications section's new "Timetable Ready" bullet for the current-
  state design; this is the changelog.
  - **Template**: new `AUTOMATIC_EVENTS.TIMETABLE_READY` in
    `lib/whatsapp-templates.ts` (placeholders `{semesterName}`,
    `{academicYear}`, `{domainName}`, `{facultyName}` — deliberately NO
    `{username}`/`{tempPassword}`), coded default `TIMETABLE_READY_DEFAULT`
    (the exact Somali text from the request). `lib/whatsapp-notify.ts`
    gained `sendTimetableReady(params)` — same "called from a Server
    Action, returns `{enqueued}`, never throws, respects the phone/enabled
    rules via the shared `enqueue`" contract as `sendLecturerCredentials`.
  - **Schema** (migration `20260902120000_timetable_ready`): new
    `LecturerTimetableNotification` model — `(lecturerId, semesterId,
    notifiedAt, notifiedById)`, `@@unique([lecturerId, semesterId])`,
    Cascade on both FKs, `notifiedById` a plain snapshot column (no FK,
    same convention as `WhatsAppNotificationLog`'s polymorphic recipient
    — the audit log is authoritative for "who sent"). This is the
    per-(lecturer, semester) sent-state the UI reads; **`User.passwordSentAt`
    / `User.pendingCredential` (the credentials tracking) are never
    touched by this feature, and vice versa**. The migration also seeds
    the `TIMETABLE_READY` `whatsapp_message_templates` row idempotently,
    `$ttr$…$ttr$` byte-identical to the code default. Migration could NOT
    be applied from the dev environment (no DB connectivity — same
    constraint noted on other recent migrations); `prisma generate` was
    run against the updated schema so the client/types are current. Must
    be applied via `prisma migrate deploy` before rollout.
  - **Actions** (`admin/auto-timetable/actions.ts`, all gated on
    `timetable.generate` — no new permission key):
    `previewSendTimetableReady(semesterNumber)` (read-only — lists every
    lecturer with a built timetable at that `Class.currentSemesterNumber`
    level in the active semester, dean-scoped via a new
    `resolveAffectedBatchLecturers` built on the existing
    `resolveAffectedBatchClasses`; per-lecturer `hasPhone` + `notifiedAt`
    + an `eligibleCount`); `sendTimetableReadyToLecturer(lecturerId,
    semesterNumber)` (single — the lecturer must be in the resolved batch
    list, which IS the scope check → `LECTURER_NOT_IN_BATCH` otherwise);
    `sendTimetableReadyBatch(semesterNumber)` (bulk — re-derives ELIGIBLE
    = has-phone AND no sent-state row for this semester, never trusts a
    client list; loops `deliverTimetableReady` per lecturer). All refuse
    with `DOMAIN_NOT_CONFIGURED` until `WhatsAppSettings.domainName` is
    set (same gate/setting as credentials). `deliverTimetableReady`
    enqueues, then on success upserts the `LecturerTimetableNotification`
    row (a **resend just bumps `notifiedAt`** — always allowed) and
    audits `LECTURER_TIMETABLE_READY_SENT` per lecturer (`semesterId` +
    `resent` flag, never one batch entry).
  - **Rate limiting**: no new mechanism — bulk send enqueues one
    `WhatsAppNotificationLog` row per lecturer immediately; the existing
    `whatsapp-service/` worker drains the queue at one message / 5 s
    (`INTER_MESSAGE_DELAY_MS` + `batchInFlight` guard), exactly like the
    credentials bulk-send and the "Send timetable notifications" batch.
  - **UI**: `admin/auto-timetable/send-timetable-ready-card.tsx` —
    `SendTimetableReadyCard`, rendered by `admin/workload-import/panel.tsx`
    between `SendTimetableNotificationsCard` and
    `ClearSemesterTimetableCard` (all three `canGenerate`-gated). Semester-
    level `Select` → an inline lecturer table with per-row "Send timetable
    ready" / "Sent {date} · Resend", a "Send to all eligible (N)" button,
    and amber banners when WhatsApp is off / the domain isn't set. Chosen
    over the Timetable Builder / auto-generate results screen / Lecturer
    Accounts because it's the one spot with a first-class "semester batch"
    concept and it's where build/generate happens; Lecturer Accounts has
    no semester context (it's department-scoped account lifecycle).
  - Tests: `lib/whatsapp-templates.test.ts` (registry now 5 keys;
    `TIMETABLE_READY` carries no username/password placeholders);
    `lib/whatsapp-notify.test.ts` (`sendTimetableReady` fills the seeded
    template, `entity: "Semester"`, no leftover tokens, `enqueued:false`
    on no-phone / disabled); `admin/auto-timetable/actions.test.ts` (new
    describe — permission gate, preview shape + `eligibleCount` math, dean
    `classDeanWhere` scoping, `LECTURER_NOT_IN_BATCH`,
    `DOMAIN_NOT_CONFIGURED`, the enqueue→upsert→audit happy path, the
    resent-flag path, no-op when nothing was enqueued, bulk targets only
    eligible + one audit each, and an explicit "never touches the
    credentials flow" assertion). Full suite: 1013 passing; `tsc
    --noEmit` and ESLint on the changed files clean.
  - Not visually verified end-to-end in a browser — same
    `next/navigation`-needs-a-real-authenticated-request constraint noted
    throughout this log.

Change — Lecturer Credentials & Timetable Ready move from the Baileys
  worker to `wa.me` manual share links (branch `main`): the automated
  send for these TWO message types is REPLACED by a "Share via WhatsApp"
  button that opens `https://wa.me/<number>?text=<filled message>` — the
  admin opens WhatsApp and hits Send themselves; this app transmits
  nothing on its own for them. See the WhatsApp Notifications section's
  updated "Lecturer login credentials" and "Timetable Ready" bullets for
  the current-state design; this is the changelog. **Leave notices,
  results-published, and timetable-change are UNCHANGED — still the
  Baileys worker with all its scoping/pacing/tracking.**
  - **`lib/whatsapp-notify.ts`**: `sendLecturerCredentials` /
    `sendTimetableReady` (which enqueued a `WhatsAppNotificationLog` row)
    are replaced by `buildLecturerCredentialsShareUrl` /
    `buildTimetableReadyShareUrl` — they fill the SAME admin-editable
    AUTOMATIC template (via the unchanged `getEffectiveAutomaticTemplate`
    cache + fallback) and return `{ url: string | null }` (null iff no
    phone number), enqueuing NOTHING. New pure `buildWaMeUrl(phone, msg)`
    (digits-only number, `encodeURIComponent` on the text). The
    `enabled` on/off toggle no longer gates either — a manual link
    doesn't touch the worker. `enqueue` and every other trigger are
    untouched.
  - **Schema** (migration `20260902130000_wa_me_share_tracking`, pure
    column RENAMEs — data preserved): `User.password_sent_at` →
    `credentials_link_opened_at`; `lecturer_timetable_notifications.
    notified_at` → `link_opened_at`, `notified_by_id` → `opened_by_id`.
    "...link opened..." not "...sent..." because a manual link has no
    server-side delivery confirmation — the app only knows the link was
    opened. Not applied from the dev env (no DB connectivity); `prisma
    generate` was run. Apply via `prisma migrate deploy`.
  - **`admin/lecturer-accounts/actions.ts`**: `sendLecturerCredentials` →
    `shareLecturerCredentials` (returns `{ status, url? }`);
    `sendLecturerCredentialsBatch` **deleted** (no bulk action — the
    per-lecturer button list IS the bulk case). Statuses renamed:
    `sent`→`opened`, `already_sent`→`already_opened`,
    `no_phone_or_disabled`→`no_phone`. Audit
    `LECTURER_CREDENTIALS_SENT`→`LECTURER_CREDENTIALS_LINK_OPENED`
    (`reopened` flag). The `PASSWORD_CHANGED` hard-block and
    `NO_STORED_CREDENTIAL` are unchanged; `ALREADY_OPENED` soft-block
    keeps the `force` "Share again" override.
  - **`admin/auto-timetable/actions.ts`**: `sendTimetableReadyToLecturer`
    → `shareTimetableReady(lecturerId, level, force?)` (returns
    `{ status, url?, linkOpenedAt }`); `sendTimetableReadyBatch`
    **deleted**. `previewSendTimetableReady`'s per-lecturer `notifiedAt`
    → `linkOpenedAt`, `eligibleCount` → `pendingCount`, dropped
    `whatsappEnabled` from the result. Audit
    `LECTURER_TIMETABLE_READY_SENT`→`LECTURER_TIMETABLE_READY_LINK_OPENED`.
    `LECTURER_NOT_IN_BATCH` / `DOMAIN_NOT_CONFIGURED` unchanged;
    `ALREADY_OPENED` soft-block + `force` added (re-sharing always
    allowed, just bumps `linkOpenedAt`).
  - **Clients**: `lecturer-accounts-client.tsx` — the "Send credentials
    to all eligible" bulk button, `sendAll`/`sendAllEligible`, and the
    batch import are gone; `sendCredentialsCell`→`shareCredentialsCell`
    ("Share via WhatsApp" / "Link opened · Share again"), the
    post-generation dialog shows an "N of M share links opened" progress
    line, and every share opens a blank tab synchronously on click then
    redirects it to the wa.me URL (popup-blocker-safe).
    `send-timetable-ready-card.tsx` — same treatment; the "Send to all
    eligible (N)" button is gone, replaced by the per-row list + an
    "N of M links opened" header. Both drop the `whatsappEnabled` gate,
    keeping only the domain-configured check.
  - **Historical `WhatsAppNotificationLog` rows** for these two event
    types (from before this change) stay as-is — the delivery-log filter
    still lists the (still-present, still-editable) template rows, so
    they remain visible/filterable. No new rows are created for them
    going forward.
  - Tests: `lib/whatsapp-notify.test.ts` — `sendLecturerCredentials`/
    `sendTimetableReady` suites replaced with
    `buildWaMeUrl`/`buildLecturerCredentialsShareUrl`/
    `buildTimetableReadyShareUrl` (URL shape, filled message, `url:null`
    on no phone, NO `whatsAppNotificationLog.create`, not gated by
    `enabled`). `admin/lecturer-accounts/actions.test.ts` — the
    `sendLecturerCredentials`/`...Batch` describes replaced with a
    `shareLecturerCredentials` describe (returns a url, stamps
    `credentialsLinkOpenedAt`, audits `..._LINK_OPENED`, `ALREADY_OPENED`
    +force, `PASSWORD_CHANGED` hard-block, `NO_STORED_CREDENTIAL`,
    `no_phone`). `admin/auto-timetable/actions.test.ts` — the Timetable
    Ready describe rewritten for `shareTimetableReady` (link-opened
    state, `..._LINK_OPENED` audit, scope check, domain gate,
    `ALREADY_OPENED`+force, `no_phone`, "never touches the credentials
    flow"). `tsc --noEmit` / ESLint / full Vitest run to be confirmed.
  - Not visually verified end-to-end in a browser — same
    `next/navigation`-needs-a-real-authenticated-request constraint noted
    throughout this log.

Fix + feature — Timetable "Now" strictness, campus-timezone resolution,
  60s live auto-refresh, and Today's-Schedule dashboard widgets (branch
  `main`): three connected pieces.
  - **PART 1 — root-cause fix for "Nearest upcoming — Saturday — 33
    upcoming" showing when it isn't Saturday.** TWO bugs:
    1. **Timezone.** `getCurrentDayAndTime` (`lib/timetable-now.ts`) read
       the raw SERVER clock. The app runs UTC (Vercel/Neon) but the
       institution is EAT (UTC+3), so on a Saturday-morning campus time
       before ~03:00, `new Date().getDay()` still said Friday and
       `getHours()` was 3h behind — everything "today" looked ended,
       nothing upcoming, so it fell forward to Saturday. Fixed: "now" is
       now resolved in the CAMPUS timezone via `Intl.DateTimeFormat` with
       an explicit `timeZone` — `CAMPUS_TIME_ZONE`, default
       `"Africa/Mogadishu"` (no DST), overridable per deployment via the
       `CAMPUS_TIMEZONE` env var. `getCurrentDayAndTime` /
       `classifyForNow` / `buildTodaySchedule` all take an optional
       `timeZone` param (defaults to `CAMPUS_TIME_ZONE`; tests pass
       `"UTC"` so a `Date` isn't reinterpreted by the runner's own zone).
    2. **Cross-day jump.** `classifyForNow` used to walk FORWARD up to 7
       days when today had no in-progress/upcoming session, returning
       `{ isFallbackDay: true, day: <future day> }`. That whole
       lookahead (`MAX_LOOKAHEAD_DAYS`, `isFallbackDay`) is DELETED.
       "Now" is strictly today: `inProgress` = `start <= now < end`
       (half-open — a session starting in 1 minute is NOT in progress,
       one that ended a minute ago is NOT in progress/upcoming),
       `next` = later TODAY only, and if both are empty the client shows
       **"Nothing else scheduled today."** — never a different day framed
       as "upcoming". `classifyForNow` now also returns an `ended` bucket
       (today's finished sessions) + the campus `time` string.
       `NowViewData.isFallbackDay` and `resolveNowView`'s fallback branch
       are removed; `now-view-client.tsx`'s "Nearest upcoming — {day}"
       header path is gone.
  - **PART 2 — 60s live auto-refresh, no reload, visibility-gated.** New
    `lib/use-visible-interval.ts` (`useVisibleInterval(cb, ms)`): runs
    `cb` every `ms` ONLY while `document.hidden` is false (Page
    Visibility API) — hidden tab clears the interval entirely; on
    becoming visible it fires `cb` once immediately and restarts. New
    lightweight server action `getNowSnapshot(filters)`
    (`admin/timetable/actions.ts`, `timetable.view`) — reuses the exact
    `getSlotsForExport` scope/semester resolution + `classifyForNow`,
    returns just `{ day, time, inProgress, next }` (no option lists, no
    grid layout — the client rebuilds `buildNowGrids`).
    `now-view-client.tsx` polls it every 60s ONLY in live mode
    (`quick === "now"` and no explicit Day) and swaps the two slot
    arrays via local `live` state (seeded from the SSR `nowView` prop;
    an effect clears it whenever the server re-renders with new
    filters). A "· updates every 60s" hint sits in the header line.
  - **PART 3 — "Today's Schedule" widget on the Lecturer & Student
    dashboards.** New `components/timetable/today-schedule-widget.tsx`
    (`"use client"`, uses `useVisibleInterval` for the same 60s refresh).
    New server actions `getMyTodayScheduleAsLecturer` /
    `getMyTodayScheduleAsStudent` (`app/(app)/today-schedule-actions.ts`,
    `timetable.view.own`) reuse the existing `getMyTimetableForLecturer`
    / `getMyTimetableForStudent` queries + a new pure
    `buildTodaySchedule` (`lib/timetable-now.ts`) that tags every one of
    today's sessions `ended | in_progress | upcoming` and sorts them by
    start time (which IS correct shift order — `startTime` is a
    zero-padded 24h string, so Morning Session 1 < Session 2 < …
    < Afternoon Session 1). **Ended sessions stay in the list**, faded
    (`opacity-55`) with an "Ended" `Badge`; the in-progress one gets a
    green row tint + "Now" `Badge` (`variant="published"`); upcoming
    render plainly. Each row shows time, course, class, room. Rendered on
    `app/(app)/page.tsx`'s `LecturerOverview` (gated
    `timetable.view.own`) and `app/(app)/student/page.tsx` (same gate).
  - Tests: `lib/timetable-now.test.ts` rewritten — the forward-fallback
    suite replaced with "NEVER jumps to a future day", `ended` bucket
    coverage, "starts in 1 minute → not in progress", "just ended → only
    `ended`", a dedicated campus-timezone regression (`Fri 23:30 UTC` →
    `SAT 02:30` in `Africa/Mogadishu`), and a `buildTodaySchedule` suite
    (tag/order/ended-retained/today-only). `admin/timetable/actions.test.ts`
    — new `getNowSnapshot` describe (permission gate, in-progress/next
    split, no cross-day jump); the `exportTimetable` fixture's fake "now"
    changed from a local `Date` to an absolute UTC instant that maps to
    Monday 10:00 campus time so it's runner-zone-independent. `tsc
    --noEmit`, ESLint, and the full Vitest suite (1008 passing) are
    clean.
  - Not visually verified end-to-end in a browser — same
    `next/navigation`-needs-a-real-authenticated-request constraint noted
    throughout this log; the pure Now/today logic + the `getNowSnapshot`
    action shape are covered by the new tests.

New feature — "Share timetable to WhatsApp Group" for students (branch
  `main`): a per-class **"Share to WhatsApp Group"** button on the
  Timetable Builder (next to "Send notifications" / "Clear timetable") —
  see the WhatsApp Notifications section's new "Class Timetable — Group
  Share" bullet for the current-state design; this is the changelog.
  Placed on the Builder because that's where a class's finalized week is
  reviewed/adjusted, and it slots naturally beside the other two
  per-class timetable actions.
  - **Template**: new `AUTOMATIC_EVENTS.CLASS_TIMETABLE_GROUP_SHARE` in
    `lib/whatsapp-templates.ts` (placeholders `{className}`,
    `{semesterName}`, `{academicYear}`, `{domainName}` — NO phone/
    username/faculty), coded default `CLASS_TIMETABLE_GROUP_SHARE_DEFAULT`
    (the exact Somali text from the request).
  - **`lib/whatsapp-notify.ts`**: new pure `buildWaMeShareUrl(message)` —
    `https://wa.me/?text=<encoded>` with **NO phone number**, so WhatsApp
    opens its own chat/GROUP picker. New
    `buildClassTimetableGroupShareUrl(params)` fills the template + wraps
    it. Grouped under the same "wa.me manual-share, never the worker"
    section as the credentials / timetable-ready builders.
  - **Schema** (migration `20260903120000_class_timetable_share`, applied
    to the dev DB via `prisma migrate deploy`): new `ClassTimetableShare`
    model — `(classId, semesterId, sharedAt, sharedById)`,
    `@@unique([classId, semesterId])`, Cascade FKs, `sharedById` a plain
    snapshot column (no FK). Records ONLY that a share happened — never
    which group (the app can't know). Also seeds the
    `CLASS_TIMETABLE_GROUP_SHARE` `whatsapp_message_templates` row
    idempotently, `$ctgs$…$ctgs$` byte-identical to the code default.
  - **`admin/timetable/actions.ts`**: `previewClassTimetableGroupShare`
    (read-only — label, semester, `domainConfigured`, `lastSharedAt`) and
    `shareClassTimetableToGroup(classId, semesterId, force?)` (builds the
    URL, upserts `ClassTimetableShare`, audits
    `CLASS_TIMETABLE_GROUP_SHARED` with a `reshared` flag, returns the
    URL). Gated on `timetable.manage`, dean-scoped via `classDeanWhere`.
    `DOMAIN_NOT_CONFIGURED` until a login domain is set; `ALREADY_SHARED`
    soft-block within `TIMETABLE_RESEND_GUARD_MS` (10 min) unless `force`.
    Does NOT enqueue anything / touch the worker / touch the on/off
    toggle.
  - **`share-class-timetable-group-button.tsx`**: same popup-blocker-safe
    pattern as the other wa.me shares (blank tab opened synchronously on
    click, redirected once the action resolves). Confirm dialog shows the
    class label + semester, an amber "already shared at [time]" banner
    with a "Share again" button, and a "no phone number is used — WhatsApp
    picks the group, this app sends nothing" note.
  - **Independence**: separate template, separate table, `{className}` not
    `{facultyName}`, no phone — fully distinct from the per-lecturer
    `TIMETABLE_READY` share and from students' in-app bell notifications.
    **Students still get ZERO automated WhatsApp.**
  - Tests: `lib/whatsapp-templates.test.ts` (registry now 6 keys;
    `CLASS_TIMETABLE_GROUP_SHARE` placeholder set, no phone/username/
    faculty). `lib/whatsapp-notify.test.ts` (`buildWaMeShareUrl` has no
    number segment; `buildClassTimetableGroupShareUrl` fills the message,
    no leftover tokens, no worker row). `admin/timetable/actions.test.ts`
    (new describe — permission gate, dean scope, preview shape,
    `DOMAIN_NOT_CONFIGURED`, the build→upsert→audit happy path, the
    `ALREADY_SHARED` guard + `force`, and an old-prior-share-outside-the-
    window is allowed without force). Full suite: 1019 passing; `tsc
    --noEmit` and ESLint on the touched files clean.
  - Not visually verified end-to-end in a browser — same
    `next/navigation`-needs-a-real-authenticated-request constraint noted
    throughout this log; the migration WAS applied to and verified
    against the real dev DB (table + seeded template row inspected
    directly).

Bug fixes — Timetable room propagation + manual room-conflict recovery
  (branch `main`): two related fixes — see the "Class Timetable" business
  rule's new "Changing `Class.roomId` bulk-propagates…" and "Manual room
  conflict → immediate 'open rooms for this shift' picker" bullets above
  for the current-state design; this is the changelog. No schema change.
  - **BUG 1 — a class room change didn't touch existing sessions.**
    `updateClass` (`admin/classes/actions.ts`) just wrote `Class.roomId`;
    already-scheduled `TimetableSlot`s kept their old room. Fixed: when
    `roomId` changes to a concrete room, `checkNewRoomForClassSlots`
    fetches every slot for the class, groups by `semesterId`, and runs
    `findTimetableConflicts` for the new room against each slot's own
    day+time — a ROOM conflict against a DIFFERENT class blocks the whole
    update (no writes) with a message listing the clashes. Otherwise a
    `$transaction([class.update, timetableSlot.updateMany(roomId)])`
    moves all of them, audited `CLASS_ROOM_BULK_UPDATED`. `updateClass`
    now returns `{ roomChange }`; `classes-client.tsx` toasts "N sessions
    moved to <room>". Reuses `getConflictCandidates` from
    `../timetable/queries` (new cross-module import,
    `admin/classes` → `admin/timetable`).
  - **BUG 2 — a manual room conflict was a dead end.** New
    `getOpenRoomsForSlot` action + `ROOM_CONFLICT_PREFIX` /
    `isRoomOnlyConflictError` in `lib/timetable-conflicts.ts`.
    `conflictErrorMessage` prefixes the thrown string when every conflict
    is ROOM-kind. **Single-slot dialog** (`timetable-client.tsx`): the
    debounced conflict `useEffect`, on a room-only result, also fetches
    open rooms (scoped to the current room's campus) and renders a
    one-click picker under the conflict box. **Drag grid**
    (`build-timetable-client.tsx`): `scheduleAssignment`/`moveSlot`/
    `updateSlot` gained an optional `roomIdOverride`; on a room-only
    rejection they open a `roomPicker` dialog listing the free rooms and
    retry the same placement with the picked one. Both show "No rooms
    available for this shift" vs "No rooms exist" distinctly.
    `lib/action-error.ts` strips the prefix for any non-manual surface.
    Auto-generate (`lib/auto-timetable.ts`) untouched.
  - Tests: `admin/classes/actions.test.ts` — new "room change
    bulk-propagation" describe (moves every session + count, audit shape,
    blocks on a different-class clash with no writes, same-class session
    isn't a blocker, no-sessions → plain update, clear-to-null → no slot
    touch). `admin/timetable/actions.test.ts` — `ROOM_CONFLICT::` prefix
    only when room-only / not when mixed; new `getOpenRoomsForSlot`
    describe (permission, free-rooms filter, campus scoping, the
    none-available vs none-exist distinction). Full suite: 1031 passing;
    `tsc --noEmit` and ESLint on the touched files clean (only the
    pre-existing `react-hooks/incompatible-library` `form.watch()`
    warnings).
  - Not visually verified end-to-end in a browser — same
    `next/navigation`-needs-a-real-authenticated-request constraint noted
    throughout this log; the pure logic + action shapes are covered by
    the new tests.

New feature — Email as a notification channel for students (branch
  `main`): students gain an optional real email address; when set it is
  used for automatic credential delivery and a mark-free results-published
  notice, both via the existing customizable-template system; when absent
  every pre-existing fallback is untouched. See the Business rules
  section's updated "Student registration is separate from account
  creation" bullet for the current-state behavior; this is the changelog.
  - **Provider**: Resend (`resend` npm, `lib/email.ts`) — first email
    provider in this project. Config: `RESEND_API_KEY` (from resend.com)
    + `EMAIL_FROM` (a Resend-verified sender, defaults to Resend's shared
    `onboarding@resend.dev` test sender). BOTH OPTIONAL — an unset key
    makes every send a no-op recorded as `SKIPPED`; the `resend` client
    is lazily constructed only when the key is present. Same
    graceful-degrade philosophy as `CREDENTIAL_ENCRYPTION_KEY`.
    `.env.production.template` documents both.
  - **Schema** (migration `20260904120000_student_email`, additive):
    `Student.email String?` (nullable real address — distinct from the
    synthetic `studentNo@students.sams.local` LOGIN email on `User`;
    format-validated when given, never required). New `EmailStatus` enum
    (`SENT`/`FAILED`/`SKIPPED`) + `email_logs` table (one row per send
    attempt — `recipientType`/`recipientId`/`recipientEmail` snapshot,
    `eventKey`, `subject`, `status`, `error`, polymorphic
    `entity`/`entityId`, no FK, mirrors `WhatsAppNotificationLog`'s
    shape) — a delivery RECORD only: Resend is synchronous so there's no
    queue/worker, and there's no admin UI page or retry for it (it's
    fire-and-forget). `WhatsAppMessageTemplate.subject String?` — the
    EMAIL-channel events store an editable subject line alongside the
    body (WhatsApp events leave it null). The migration also idempotently
    seeds the two new template rows (`$scemail$…$scemail$` /
    `$rpemail$…$rpemail$` dollar-quoted Somali bodies + subjects,
    byte-identical to the `lib/whatsapp-templates.ts` consts so "Reset to
    default" agrees).
  - **`lib/whatsapp-templates.ts`**: `AutomaticEventDefinition` gained
    `channel?: "WHATSAPP" | "EMAIL"` (defaulted via a new
    `channelFor(eventKey)` helper) + `defaultSubject?`. Two new
    `AUTOMATIC_EVENTS` entries, `channel: "EMAIL"`:
    `STUDENT_LOGIN_CREDENTIALS_EMAIL` (placeholders `studentName`,
    `studentNo`, `username`, `tempPassword`, `domainName`) and
    `RESULTS_PUBLISHED_EMAIL` (`studentName`, `courseName`,
    `assessmentTitle`, `className`, `semesterName`, `domainName` —
    deliberately NO `{mark}`, pinned by a test). Registry is now 8 keys
    (6 WhatsApp + 2 email). Both are `isSystem` — editable wording +
    subject, not deletable, same as every other AUTOMATIC row.
  - **`lib/whatsapp-notify.ts`**: the 60s `templateCache` now stores
    `{ templateText, subject, triggerKind }` per row; new
    `getEffectiveAutomaticEmail(eventKey)` returns `{ subject, body }`,
    trusting a stored value only when non-blank with no unknown
    placeholders, else the coded defaults (same fallback-safety rule as
    `getEffectiveAutomaticTemplate`).
  - **`lib/email-notify.ts`** (the student-email counterpart to the
    WhatsApp notify functions — all fire-and-forget, never throw):
    `emailStudentCredentials({studentId, studentNo, fullName, email,
    username, tempPassword})` — no-op when `email` is null; fills the
    `STUDENT_LOGIN_CREDENTIALS_EMAIL` template + subject
    (`{domainName}` from `WhatsAppSettings.domainName`, same setting the
    lecturer wa.me flow uses) and `sendEmail`s. `emailResultsPublished(
    assessmentId)` — fetches the assessment's course/class/semester
    names + every PUBLISHED result's student `{id, fullName, email}`,
    filters to those with an email, fills `RESULTS_PUBLISHED_EMAIL` once
    per student (NO mark), one `sendEmail` each.
  - **Trigger points** (plain `await` after the core action + its audit,
    exactly like `notifyResultsPublished`): `generateAccountsForClass` /
    `generateAccountForStudent` (`admin/student-accounts/actions.ts`) →
    `emailStudentCredentials` per generated account (class variant fans
    out via `Promise.all`); `publishAssessment` (`lecturer/assessments/
    [assessmentId]/actions.ts`) → `emailResultsPublished` right after the
    existing `notifyResultsPublished` bell hook. A missing student email,
    an unset key, or a provider failure changes nothing about whether the
    account is created / the results are published.
  - **Forms/import**: Student Registration form gained an optional Email
    field (`emailField` Zod: trimmed, `.email()`, `.optional().or(literal
    ""))`); `registerStudent` writes `email: data.email || null`. Students
    bulk import gained an optional `email` column (added to the
    downloadable template, `EMAIL_PATTERN`-validated per row with the
    same "invalid → row ERROR, blank → skip" treatment as `phone_number`);
    `confirmStudentImport` writes it.
  - **Admin Templates UI** (`admin/whatsapp/templates-client.tsx` +
    `actions.ts`): an EMAIL-channel card shows an "Email" badge, an
    editable Subject `Input` (with its own unknown-placeholder warning +
    live `Subject:` preview line), and Save is disabled on a blank/
    invalid subject too. `updateWhatsAppTemplate` gained an optional 3rd
    `subject` arg (validated + placeholder-checked for EMAIL rows,
    preserved for WhatsApp rows); `resetWhatsAppTemplate` restores
    `def.defaultSubject` for EMAIL rows (null otherwise). Both audit the
    subject old→new alongside the body.
  - Tests: new `lib/email.test.ts` (5 — SKIPPED on null `to` / unset key,
    SENT happy path asserting the `{from,to,subject,text}` call + log,
    FAILED on a Resend error, swallows a thrown error), new
    `lib/email-notify.test.ts` (6 — no-email no-op, credentials fill +
    log context + no leftover `{tokens}`, never-throws-on-DB-failure,
    results email to only the email-having students with NO mark in the
    message, nothing when nobody has an email, never throws).
    `lib/whatsapp-templates.test.ts` (8-key list + the two email events
    are `channel:"EMAIL"` with a `defaultSubject` + the no-`{mark}` pin),
    `admin/students/actions.test.ts` / `bulk-import-actions.test.ts`
    (`email: null` threaded into the create-call assertions),
    `admin/whatsapp/actions.test.ts` (EMAIL subject reset). Full suite:
    1045 passing. `tsc --noEmit` and ESLint on the touched files clean.
  - Not visually verified end-to-end in a browser — same
    `next/navigation`-needs-a-real-authenticated-request constraint noted
    throughout this log; the migration WAS applied to and verified
    against the real dev DB (the two seeded template rows + `students.
    email` + `email_logs` + `whatsapp_message_templates.subject`
    inspected directly).

Regression fix — cross-period shift override stopped working for
  lecturers with day+shift availability rules (branch `main`): the
  manual, per-session "Allow cross-period shift for this session" override
  (an FT Morning-period class occasionally using a Galab/Afternoon shift,
  or vice versa — see CLAUDE.md's "Period" business rule's "cross-period
  override" bullet) was being silently filtered back out on both manual
  surfaces whenever the session's lecturer had ANY `LecturerAvailability`
  day+shift rule for the picked day.
  - **Cause**: commit `9df7fcb` ("Upgrade lecturer availability from
    day-only to day+shift granularity", built on `cde47ad`) added an
    `isShiftAllowedForLecturerOnDay(pickedDay, shift.id, rules)` narrowing
    to (a) the single-slot Add/Edit dialog's `shiftsForClass`
    (`admin/timetable/timetable-client.tsx`) and (b) `ScheduleGrid`'s
    per-cell `restrictedCellBlocked` (`components/timetable/
    schedule-grid.tsx`, used by the drag-and-drop Builder and the
    auto-generate multi-class overview). Both apply that check
    UNCONDITIONALLY, including to cross-period shifts/rows — and a
    cross-period shift, by construction, is never in the lecturer's
    own-period-derived availability shift list, so the check always
    returned false for it and the override could never take effect. For
    an UNRESTRICTED lecturer (`rules.length === 0`, the common case)
    `isShiftAllowedForLecturerOnDay` returns true, so cross-period kept
    working — which is why this only surfaced once someone set a lecturer
    day+shift restriction via the auto-generate "Lecturer availability"
    wizard and then tried a manual cross-period exception for that
    lecturer. Server-side `createTimetableSlot`/`updateTimetableSlot`/
    `confirmAutoTimetableBatch` were checked and are clean — they have no
    period/availability validation at all (`findTimetableConflicts` is
    period-agnostic by design), so this was a client-picker/drop-target
    regression only, no server change needed.
  - **Watch for**: any future change that layers a new per-(day, shift)
    or per-period filter onto a manual timetable shift picker / grid cell
    must exempt the cross-period case (`s.period !== classPeriod` with the
    override on, or `row.crossPeriod`), exactly as it must already exempt
    it from the strict own-period match.
  - **Fix**: new pure `isShiftOfferableForClassDay(...)` in
    `lib/timetable-days.ts` folds the three gates (studyMode match →
    period gate, own-period always / other-period only with the override
    → lecturer day+shift availability) into one tested predicate, with the
    key rule that a **cross-period shift is EXEMPT from the availability
    shift-level narrowing** (the day-level "is this lecturer available
    this day at all" check still applies upstream via
    `restrictedDaysForLecturer`, which drives the Day dropdown's options).
    `timetable-client.tsx`'s `shiftsForClass` now calls it;
    `schedule-grid.tsx`'s `restrictedCellBlocked` gained a leading
    `!row.crossPeriod &&` guard so a cross-period row is never disabled as
    a drop target by the availability check. Strict own-period filtering
    and the full (day, shift) availability block on OWN-period shifts/rows
    are byte-for-byte unchanged (override off → nothing changes;
    unrestricted lecturer → nothing changes). Verified in both the manual
    Builder (drag onto a "Show cross-period shifts" row) and the
    single-slot Add/Edit dialog (check the toggle → the other period's
    shifts appear in the picker, labelled "— cross-period").
  - Tests: `lib/timetable-days.test.ts` gained a
    `describe("isShiftOfferableForClassDay")` block (10 cases) — the
    regression itself (Afternoon class + Morning shift + override ON +
    a restricted lecturer → offered), override OFF still hides it
    (restricted AND unrestricted), an OWN-period shift is still narrowed
    by the lecturer's day+shift rule (fix doesn't loosen that), a
    period-less FT class can never cross-period, PT unaffected, studyMode
    mismatch never offered, no-day-picked-yet. Full suite: 1055 passing;
    `tsc --noEmit` and ESLint on the touched files clean (only the
    pre-existing `react-hooks/incompatible-library` `form.watch()`
    warning). Not re-verified end-to-end in a browser — same
    `next/navigation`-needs-a-real-authenticated-request constraint noted
    throughout this log.

Investigation + fix — "Could not schedule this session" on a cross-period
  drop in the Timetable Builder (branch `main`): reported as the
  cross-period override still being rejected for drag-and-drop even after
  the previous regression fix.
  - **Finding: nothing rejects the cross-period override.** Traced every
    Builder scheduling path — `scheduleAssignment` (drag a course chip
    onto a cell), `moveSlot` (drag a placed session), `updateSlot` (the
    per-card "Cross-period override" checkbox + inline shift picker). All
    three derive `crossPeriodOverride` from the target row's
    `row.crossPeriod` / the patch and pass it through. The server actions
    `createTimetableSlot`/`updateTimetableSlot` have (and are meant to
    keep) NO period/shift validation of their own — only `assertValidDay`
    (day-of-week vs studyMode) and `findTimetableConflicts`
    (room/lecturer/class, which is period-agnostic by design). Confirmed
    against the real dev DB: a conflict-free cross-period `createTimetableSlot`
    (Morning class, Afternoon/Galab time, `crossPeriodOverride: true`)
    succeeds and persists the flag. `getConflictCandidates`/schema/
    `resolveScopedAssignment` were all checked — no period gate anywhere.
  - **Actual cause: a misleading generic error.** `scheduleAssignment`'s
    catch (and `moveSlot`/`updateSlot`) passed the failure through
    `getActionErrorMessage(error, "Could not schedule this session.")`,
    which returns the bare fallback for ANY message it doesn't explicitly
    recognize — including the genuine, user-facing conflict SENTENCES the
    timetable actions throw (`"Room A101 is already booked for … on MON
    09:00-10:00."`, `"Dr. Ahmed already teaches …"`, `"Thursday is not a
    valid teaching day …"`). A cross-period placement almost always lands
    on a time some other class already owns — a class's default room is
    typically a shared room booked solid by the OTHER period's classes at
    that hour — so the drop hits a real room (often room+lecturer)
    conflict, and the generic message made it look identical to the
    cross-period override being rejected. (A room-ONLY clash already
    opened the "open rooms for this shift" picker via
    `isRoomOnlyConflictError`; a room+lecturer or lecturer/class clash
    fell through to the useless generic toast.)
  - **Fix**: new `getSchedulingErrorMessage(error, fallback)` in
    `lib/action-error.ts` — reuses `getActionErrorMessage` for recognized
    codes, strips `ROOM_CONFLICT_PREFIX`, and otherwise shows the thrown
    message verbatim when it's prose (has whitespace, isn't a bare
    `SCREAMING_SNAKE_CASE` code), else the generic fallback. Wired into
    `build-timetable-client.tsx`'s `scheduleAssignment` / `moveSlot` /
    `updateSlot` catch branches (the room-only → open-rooms-picker branch
    is unchanged). A conflict-free cross-period drop already succeeded and
    still does; a clashing one now says exactly which room/lecturer/class
    is in the way.
  - Tests: new `lib/action-error.test.ts` (`getSchedulingErrorMessage`:
    conflict/invalid-day sentences surface verbatim, `ROOM_CONFLICT::`
    stripped, recognized codes keep their friendly text, opaque
    `SCREAMING_SNAKE` codes / non-Error / empty message keep the generic
    fallback; plus baseline `getActionErrorMessage` coverage).
    `admin/timetable/actions.test.ts` gained two `createTimetableSlot`
    cases — a cross-period placement onto an other-period time with no
    conflict schedules and persists `crossPeriodOverride: true` (guards
    against any future server-side period gate), and a cross-period
    placement onto an already-booked room still throws the readable room-
    clash sentence (hard conflicts are never bypassed). Full suite: 1067
    passing; `tsc --noEmit` and ESLint on the touched files clean.
  - Not re-verified end-to-end in a browser — same
    `next/navigation`-needs-a-real-authenticated-request constraint noted
    throughout this log; the server path was verified directly against
    the real dev DB.

Update this section whenever a phase is completed.
