import { z } from "zod";

const dayOfWeekSchema = z.enum(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]);

// A real Shift, carried by reference (id + display fields) so a round-
// tripped row never needs a separate lookup to show/use it — mirrors
// lib/timetable-days.ts's LecturerAvailabilityShiftRef exactly.
const lecturerAvailabilityShiftRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  studyMode: z.enum(["FT", "PT"]),
  period: z.enum(["MORNING", "AFTERNOON"]).nullable(),
});

// One day a lecturer is available on — empty `shifts` means every shift
// that day is allowed (day-level only); non-empty means ONLY those
// shifts. Mirrors lib/timetable-days.ts's LecturerAvailabilityDayRule.
const lecturerAvailabilityDayRuleSchema = z.object({
  dayOfWeek: dayOfWeekSchema,
  shifts: z.array(lecturerAvailabilityShiftRefSchema),
});

// One OK row's shape after preview validation — sent back verbatim to
// confirmWorkloadImport, and (for created rows) forwarded into the
// auto-timetable generator if the admin/dean chooses "Continue".
export const workloadImportRowSchema = z.object({
  semesterId: z.string().min(1),
  semesterLabel: z.string().min(1),
  classId: z.string().min(1),
  className: z.string().min(1),
  classCurrentSemesterNumber: z.number().int().nullable(),
  studyMode: z.enum(["FT", "PT"]).nullable(),
  // The class's default room (Class.roomId, set at class registration —
  // see CLAUDE.md's "Class Timetable" business rule), carried through so
  // the auto-timetable generator can tell upfront which classes need a
  // room set before it can generate for them, without a second round trip.
  classRoomId: z.string().nullable(),
  classRoomLabel: z.string().nullable(),
  // The class's own period (Morning/Afternoon) — FT-only, always null for
  // PT. Carried through the same way as classRoomId so the auto-timetable
  // generator can tell upfront which FT classes still need a period set,
  // and so its shift-override picker never offers a wrong-period shift.
  classPeriod: z.enum(["MORNING", "AFTERNOON"]).nullable(),
  courseId: z.string().min(1),
  courseName: z.string().min(1),
  lecturerId: z.string().min(1),
  lecturerName: z.string().min(1),
  // OPTIONAL hard scheduling constraint, day+shift granularity (see
  // LecturerAvailability) — carried through the same way as
  // classRoomId/classPeriod so the auto-timetable generator's preview/
  // mini-grid/fullscreen drag-and-drop can enforce it without a second
  // round trip. Empty array = unrestricted.
  lecturerAvailability: z.array(lecturerAvailabilityDayRuleSchema),
  creditHours: z.number().positive(),
});

export type WorkloadImportRow = z.infer<typeof workloadImportRowSchema>;

export const confirmWorkloadImportSchema = z.array(workloadImportRowSchema);
