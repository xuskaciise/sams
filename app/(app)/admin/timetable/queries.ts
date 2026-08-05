import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getUserAccess } from "@/lib/auth";
import { getDeanDepartmentIds, assignmentDeanWhere, classDeanWhere } from "@/lib/dean-scope";
import type { ConflictCandidateSlot } from "@/lib/timetable-conflicts";
import { nullableDecimalToNumber } from "@/lib/serialize";
import { ALL_SEMESTERS_VALUE } from "./constants";

export interface TimetableFilters {
  classId?: string;
  lecturerId?: string;
  roomId?: string;
  campusId?: string;
  semesterId?: string;
}

// Shared by both the Admin panel (no scope) and the Dean panel (scope =
// { assignment: assignmentDeanWhere(departmentIds) }) — same
// filters-AND-on-top-of-scope idiom as Daily Log's buildDailyLogWhere.
export function buildTimetableWhere(
  filters: TimetableFilters,
  scope?: Prisma.TimetableSlotWhereInput
): Prisma.TimetableSlotWhereInput {
  const conditions: Prisma.TimetableSlotWhereInput[] = [];
  if (scope) conditions.push(scope);
  if (filters.classId) conditions.push({ assignment: { classId: filters.classId } });
  if (filters.lecturerId) conditions.push({ assignment: { lecturerId: filters.lecturerId } });
  if (filters.roomId) conditions.push({ roomId: filters.roomId });
  if (filters.campusId) conditions.push({ room: { campusId: filters.campusId } });
  if (filters.semesterId) conditions.push({ assignment: { semesterId: filters.semesterId } });
  return conditions.length > 0 ? { AND: conditions } : {};
}

const slotInclude = {
  assignment: {
    include: {
      lecturer: true,
      course: true,
      class: true,
      semester: true,
    },
  },
  room: { include: { campus: true } },
} satisfies Prisma.TimetableSlotInclude;

export async function getTimetableSlots(where: Prisma.TimetableSlotWhereInput) {
  const slots = await prisma.timetableSlot.findMany({
    where,
    include: slotInclude,
    orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
  });
  // assignment.creditHours is a nullable Decimal — not a plain object, so
  // every slot crossing into a Client Component (every consumer of this
  // function) must have it converted first. See lib/serialize.ts.
  return slots.map((s) => ({
    ...s,
    assignment: { ...s.assignment, creditHours: nullableDecimalToNumber(s.assignment.creditHours) },
  }));
}

export type SlotRow = Awaited<ReturnType<typeof getTimetableSlots>>[number];

// All conflict candidates for one semester — used by both the real
// create/update pre-check and the live client-side preview action. Not
// scoped by dean/admin: a conflict is a conflict regardless of who's
// scheduling around it (a Dean must be blocked from double-booking a room
// another faculty already holds, not just their own).
export async function getConflictCandidates(
  semesterId: string
): Promise<ConflictCandidateSlot[]> {
  const slots = await prisma.timetableSlot.findMany({
    where: { assignment: { semesterId } },
    include: {
      assignment: {
        include: { lecturer: true, course: true, class: true },
      },
      room: true,
    },
  });

  return slots.map((s) => ({
    id: s.id,
    dayOfWeek: s.dayOfWeek,
    startTime: s.startTime,
    endTime: s.endTime,
    roomId: s.roomId,
    roomName: s.room.name,
    lecturerId: s.assignment.lecturerId,
    lecturerName: s.assignment.lecturer.fullName,
    classId: s.assignment.classId,
    className: s.assignment.class.name,
    courseName: s.assignment.course.name,
  }));
}

export interface TimetablePanelSearchParams {
  classId?: string;
  lecturerId?: string;
  roomId?: string;
  campusId?: string;
  semesterId?: string;
}

async function getAssignmentOptions(where: Prisma.LecturerCourseAssignmentWhereInput) {
  const assignments = await prisma.lecturerCourseAssignment.findMany({
    where,
    include: { lecturer: true, course: true, class: true, semester: true },
    orderBy: [{ class: { name: "asc" } }, { course: { name: "asc" } }],
  });
  // creditHours is a nullable Decimal — see lib/serialize.ts.
  return assignments.map((a) => ({ ...a, creditHours: nullableDecimalToNumber(a.creditHours) }));
}

// Includes lecturers with no account yet (userId null) — they can already
// be assigned to teach a course (see admin/assignments/panel.tsx), so the
// timetable's Lecturer filter must be able to find their sessions too;
// only a DEACTIVATED account excludes one.
function getLecturerOptions() {
  return prisma.lecturer.findMany({
    where: { OR: [{ userId: null }, { user: { deletedAt: null } }] },
    orderBy: { fullName: "asc" },
  });
}

function getSemesterOptions() {
  return prisma.semester.findMany({
    include: { academicYear: true },
    orderBy: { startDate: "desc" },
  });
}

// Campuses, like Rooms, have no department/faculty affiliation in the
// schema — unscoped for both ADMIN and DEAN, same as the room list.
function getCampusOptions() {
  return prisma.campus.findMany({
    where: { deletedAt: null },
    orderBy: { name: "asc" },
  });
}

// Always the full active-room list, regardless of the grid's campus
// filter — the campus filter narrows which SLOTS are shown (server-side,
// via campusId in buildTimetableWhere) and the client narrows the Room
// filter's own options locally when a campus is selected, same
// progressive-narrowing pattern as Assignments' class-narrows-course
// picker, without needing a second round trip just for that.
function getRoomOptions() {
  return prisma.room.findMany({
    where: { deletedAt: null },
    include: { campus: true },
    orderBy: [{ campus: { name: "asc" } }, { name: "asc" }],
  });
}

// Shifts, like Campuses/Rooms, have no department/faculty affiliation —
// unscoped for both ADMIN and DEAN. Every timetable.manage holder can see
// and pick from the shift list when entering a session's time (only
// creating/editing a Shift itself requires the separate shift.manage
// key — see shifts/actions.ts).
export function getShiftOptions() {
  return prisma.shift.findMany({
    where: { deletedAt: null },
    orderBy: [{ studyMode: "asc" }, { name: "asc" }],
  });
}

// Includes each class's default room (Class.roomId, set at class
// registration/edit time — see CLAUDE.md's "Class Timetable" business
// rule) + its campus, so the Build Timetable grid can read it directly
// instead of asking for a room per build session.
function getClassOptions(where: Prisma.ClassWhereInput) {
  return prisma.class.findMany({
    where,
    include: { room: { include: { campus: true } } },
    orderBy: { name: "asc" },
  });
}

export interface TimetablePanelData {
  slots: Awaited<ReturnType<typeof getTimetableSlots>>;
  assignments: Awaited<ReturnType<typeof getAssignmentOptions>>;
  rooms: Awaited<ReturnType<typeof getRoomOptions>>;
  campuses: Awaited<ReturnType<typeof getCampusOptions>>;
  shifts: Awaited<ReturnType<typeof getShiftOptions>>;
  semesters: Awaited<ReturnType<typeof getSemesterOptions>>;
  classes: Awaited<ReturnType<typeof getClassOptions>>;
  lecturers: Awaited<ReturnType<typeof getLecturerOptions>>;
  activeSemesterId: string;
  unassigned: boolean;
}

interface TimetableRoleScope {
  isDean: boolean;
  unassigned: boolean;
  scope?: Prisma.TimetableSlotWhereInput;
  assignmentWhere: Prisma.LecturerCourseAssignmentWhereInput;
  classWhere: Prisma.ClassWhereInput;
}

// Re-derives the real scope boundary from the caller's ROLE, not the
// route — the same idiom as getDailyLogPanelData. Shared by
// getTimetablePanelData (page render) and getSlotsForExport
// (admin/timetable/actions.ts's exportTimetable), so the page and its
// export can never disagree about what a given Dean is allowed to see.
async function resolveTimetableScope(userId: string): Promise<TimetableRoleScope> {
  const { roleNames } = await getUserAccess(userId);
  const isDean = roleNames.includes("DEAN");

  if (!isDean) {
    return { isDean: false, unassigned: false, assignmentWhere: {}, classWhere: { deletedAt: null } };
  }

  const departmentIds = await getDeanDepartmentIds(userId);
  if (departmentIds.length === 0) {
    return { isDean: true, unassigned: true, assignmentWhere: {}, classWhere: { deletedAt: null } };
  }

  return {
    isDean: true,
    unassigned: false,
    scope: { assignment: assignmentDeanWhere(departmentIds) },
    assignmentWhere: assignmentDeanWhere(departmentIds),
    classWhere: { deletedAt: null, ...classDeanWhere(departmentIds) },
  };
}

// Shared by getTimetablePanelData and getSlotsForExport so a filter value
// of "all" (ALL_SEMESTERS_VALUE) or an omitted one resolves identically in
// both places.
function resolveEffectiveSemesterId(
  requestedSemesterId: string | undefined,
  semesters: { id: string; isActive: boolean }[]
): string | undefined {
  if (requestedSemesterId === ALL_SEMESTERS_VALUE) return undefined;
  return requestedSemesterId ?? semesters.find((s) => s.isActive)?.id;
}

// The ONE place that decides WHAT a caller sees, regardless of which
// route (/admin/timetable or /dean/timetable) rendered it — same
// re-derive-scope-from-role pattern as getDailyLogPanelData. `assignments`
// (the Add/Edit dialog's picker) is deliberately NOT filtered by the
// grid's semester filter — a manager may want to schedule a slot for a
// different semester than the one currently being viewed.
export async function getTimetablePanelData(
  userId: string,
  searchParams: TimetablePanelSearchParams
): Promise<TimetablePanelData> {
  const roleScope = await resolveTimetableScope(userId);

  if (roleScope.unassigned) {
    return {
      slots: [],
      assignments: [],
      rooms: [],
      campuses: [],
      shifts: [],
      semesters: [],
      classes: [],
      lecturers: [],
      activeSemesterId: "",
      unassigned: true,
    };
  }

  const semesters = await getSemesterOptions();
  const activeSemester = semesters.find((s) => s.isActive) ?? null;
  const effectiveSemesterId = resolveEffectiveSemesterId(searchParams.semesterId, semesters);

  const where = buildTimetableWhere(
    {
      classId: searchParams.classId,
      lecturerId: searchParams.lecturerId,
      roomId: searchParams.roomId,
      campusId: searchParams.campusId,
      semesterId: effectiveSemesterId,
    },
    roleScope.scope
  );

  const [slots, assignments, rooms, campuses, shifts, classes, lecturers] = await Promise.all([
    getTimetableSlots(where),
    getAssignmentOptions(roleScope.assignmentWhere),
    getRoomOptions(),
    getCampusOptions(),
    getShiftOptions(),
    getClassOptions(roleScope.classWhere),
    getLecturerOptions(),
  ]);

  return {
    slots,
    assignments,
    rooms,
    campuses,
    shifts,
    semesters,
    classes,
    lecturers,
    activeSemesterId: activeSemester?.id ?? "",
    unassigned: false,
  };
}

export interface TimetableExportFilters {
  classId?: string;
  lecturerId?: string;
  roomId?: string;
  campusId?: string;
  semesterId?: string;
}

// Used by exportTimetable (admin/timetable/actions.ts) to fetch EXACTLY the
// same slot set the on-screen "Now" view resolved to at export time —
// reuses the identical scope/semester/where resolution as
// getTimetablePanelData so the two paths can never drift apart on what a
// given filter combination means. An unassigned Dean gets an empty export,
// not an error — matches every other dean-scoped empty state.
export async function getSlotsForExport(userId: string, filters: TimetableExportFilters) {
  const roleScope = await resolveTimetableScope(userId);
  if (roleScope.unassigned) return [];

  const semesters = await getSemesterOptions();
  const effectiveSemesterId = resolveEffectiveSemesterId(filters.semesterId, semesters);

  const where = buildTimetableWhere(
    {
      classId: filters.classId,
      lecturerId: filters.lecturerId,
      roomId: filters.roomId,
      campusId: filters.campusId,
      semesterId: effectiveSemesterId,
    },
    roleScope.scope
  );

  return getTimetableSlots(where);
}

// Lecturer's own read-only timetable (timetable.view.own) — the scope
// check IS the query, through the assignment's lecturer relation's own
// userId, same idiom as getMyLeaveNotices.
export async function getMyTimetableForLecturer(userId: string) {
  return prisma.timetableSlot.findMany({
    where: { assignment: { lecturer: { userId } } },
    include: slotInclude,
    orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
  });
}

// Student's own read-only timetable (timetable.view.own). There's no
// direct relation from StudentCourseEnrollment to LecturerCourseAssignment
// (enrollments key on course+class+semester, assignments are the
// lecturer+course+class+semester tuple, matched implicitly) — so this
// resolves the student's own ACTIVE enrollments first (itself scoped
// through student.userId) and only then looks up slots for assignments
// matching one of those exact tuples. A student with no active
// enrollments simply gets an empty schedule, never another student's.
export async function getMyTimetableForStudent(userId: string) {
  const enrollments = await prisma.studentCourseEnrollment.findMany({
    where: { student: { userId }, status: "ACTIVE" },
    select: { courseId: true, classId: true, semesterId: true },
  });
  if (enrollments.length === 0) return [];

  return prisma.timetableSlot.findMany({
    where: {
      assignment: {
        OR: enrollments.map((e) => ({
          courseId: e.courseId,
          classId: e.classId,
          semesterId: e.semesterId,
        })),
      },
    },
    include: slotInclude,
    orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
  });
}
