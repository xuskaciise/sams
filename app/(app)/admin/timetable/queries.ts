import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getUserAccess } from "@/lib/auth";
import { getDeanDepartmentIds, assignmentDeanWhere, classDeanWhere } from "@/lib/dean-scope";
import type { ConflictCandidateSlot } from "@/lib/timetable-conflicts";
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
      lecturer: { include: { user: true } },
      course: true,
      class: true,
      semester: true,
    },
  },
  room: { include: { campus: true } },
} satisfies Prisma.TimetableSlotInclude;

export async function getTimetableSlots(where: Prisma.TimetableSlotWhereInput) {
  return prisma.timetableSlot.findMany({
    where,
    include: slotInclude,
    orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
  });
}

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
        include: { lecturer: { include: { user: true } }, course: true, class: true },
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
    lecturerName: s.assignment.lecturer.user.fullName,
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

function getAssignmentOptions(where: Prisma.LecturerCourseAssignmentWhereInput) {
  return prisma.lecturerCourseAssignment.findMany({
    where,
    include: { lecturer: { include: { user: true } }, course: true, class: true, semester: true },
    orderBy: [{ class: { name: "asc" } }, { course: { name: "asc" } }],
  });
}

function getLecturerOptions() {
  return prisma.lecturer.findMany({
    include: { user: true },
    where: { user: { deletedAt: null } },
    orderBy: { user: { fullName: "asc" } },
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

export interface TimetablePanelData {
  slots: Awaited<ReturnType<typeof getTimetableSlots>>;
  assignments: Awaited<ReturnType<typeof getAssignmentOptions>>;
  rooms: Awaited<ReturnType<typeof getRoomOptions>>;
  campuses: Awaited<ReturnType<typeof getCampusOptions>>;
  semesters: Awaited<ReturnType<typeof getSemesterOptions>>;
  classes: Awaited<ReturnType<typeof prisma.class.findMany>>;
  lecturers: Awaited<ReturnType<typeof getLecturerOptions>>;
  activeSemesterId: string;
  unassigned: boolean;
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
  const { roleNames } = await getUserAccess(userId);
  const isDean = roleNames.includes("DEAN");

  let scope: Prisma.TimetableSlotWhereInput | undefined;
  let assignmentWhere: Prisma.LecturerCourseAssignmentWhereInput = {};
  let classWhere: Prisma.ClassWhereInput = { deletedAt: null };

  if (isDean) {
    const departmentIds = await getDeanDepartmentIds(userId);
    if (departmentIds.length === 0) {
      return {
        slots: [],
        assignments: [],
        rooms: [],
        campuses: [],
        semesters: [],
        classes: [],
        lecturers: [],
        activeSemesterId: "",
        unassigned: true,
      };
    }
    scope = { assignment: assignmentDeanWhere(departmentIds) };
    assignmentWhere = assignmentDeanWhere(departmentIds);
    classWhere = { ...classWhere, ...classDeanWhere(departmentIds) };
  }

  const semesters = await getSemesterOptions();
  const activeSemester = semesters.find((s) => s.isActive) ?? null;
  const effectiveSemesterId =
    searchParams.semesterId === ALL_SEMESTERS_VALUE
      ? undefined
      : (searchParams.semesterId ?? activeSemester?.id);

  const where = buildTimetableWhere(
    {
      classId: searchParams.classId,
      lecturerId: searchParams.lecturerId,
      roomId: searchParams.roomId,
      campusId: searchParams.campusId,
      semesterId: effectiveSemesterId,
    },
    scope
  );

  const [slots, assignments, rooms, campuses, classes, lecturers] = await Promise.all([
    getTimetableSlots(where),
    getAssignmentOptions(assignmentWhere),
    getRoomOptions(),
    getCampusOptions(),
    prisma.class.findMany({ where: classWhere, orderBy: { name: "asc" } }),
    getLecturerOptions(),
  ]);

  return {
    slots,
    assignments,
    rooms,
    campuses,
    semesters,
    classes,
    lecturers,
    activeSemesterId: activeSemester?.id ?? "",
    unassigned: false,
  };
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
