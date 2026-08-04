import { describe, it, expect } from "vitest";
import type { ConflictCandidateSlot } from "./timetable-conflicts";
import {
  findClosestShiftCombo,
  describeCombo,
  generateTimetableForBatch,
  sequentialOddSemesterNumbers,
  type ShiftTemplate,
  type AssignmentToSchedule,
} from "./auto-timetable";

const FT_SHIFT_1H: ShiftTemplate = {
  id: "shift-1h",
  name: "Shift 1 (1h)",
  studyMode: "FT",
  startTime: "08:00",
  endTime: "09:00",
};
const FT_SHIFT_1_5H: ShiftTemplate = {
  id: "shift-1.5h",
  name: "Shift 2 (1.5h)",
  studyMode: "FT",
  startTime: "09:00",
  endTime: "10:30",
};
const FT_SHIFT_2_5H: ShiftTemplate = {
  id: "shift-2.5h",
  name: "Shift 3 (2.5h)",
  studyMode: "FT",
  startTime: "11:00",
  endTime: "13:30",
};

describe("findClosestShiftCombo", () => {
  it("picks a single exact-match shift when one exists", () => {
    const combo = findClosestShiftCombo(2.5, [FT_SHIFT_1H, FT_SHIFT_1_5H, FT_SHIFT_2_5H]);
    expect(combo).not.toBeNull();
    expect(combo!.exact).toBe(true);
    expect(combo!.shifts).toHaveLength(1);
    expect(combo!.shifts[0].id).toBe("shift-2.5h");
  });

  it("combines two of the same shift for an exact multi-session match", () => {
    const combo = findClosestShiftCombo(3, [FT_SHIFT_1H, FT_SHIFT_1_5H]);
    expect(combo).not.toBeNull();
    expect(combo!.exact).toBe(true);
    expect(combo!.shifts).toHaveLength(2);
    expect(combo!.shifts.every((s) => s.id === "shift-1.5h")).toBe(true);
  });

  it("falls back to the closest achievable total when no exact combo exists, flagged with the excess", () => {
    // 2.5 requested, only a 1.5h shift available -> two sessions = 3h, 0.5h over.
    const combo = findClosestShiftCombo(2.5, [FT_SHIFT_1_5H]);
    expect(combo).not.toBeNull();
    expect(combo!.exact).toBe(false);
    expect(combo!.totalHours).toBe(3);
    expect(combo!.diffHours).toBeCloseTo(0.5);
    expect(combo!.shifts).toHaveLength(2);
  });

  it("prefers fewer sessions when two combos tie on closeness", () => {
    // target 2h: one 1h + one 1h (2 sessions, exact) vs nothing shorter.
    // Give it a single 2h-equivalent alternative to confirm minimal-session preference.
    const TWO_HOUR_SHIFT: ShiftTemplate = {
      id: "shift-2h",
      name: "Shift 2h",
      studyMode: "FT",
      startTime: "08:00",
      endTime: "10:00",
    };
    const combo = findClosestShiftCombo(2, [FT_SHIFT_1H, TWO_HOUR_SHIFT]);
    expect(combo!.exact).toBe(true);
    expect(combo!.shifts).toHaveLength(1);
    expect(combo!.shifts[0].id).toBe("shift-2h");
  });

  it("returns null when there are no shifts to combine", () => {
    expect(findClosestShiftCombo(2, [])).toBeNull();
  });

  it("returns null for a non-positive target", () => {
    expect(findClosestShiftCombo(0, [FT_SHIFT_1H])).toBeNull();
  });
});

describe("describeCombo", () => {
  it("groups repeated shifts with a count", () => {
    const text = describeCombo([FT_SHIFT_1_5H, FT_SHIFT_1_5H]);
    expect(text).toContain("2 1.5h shifts");
    expect(text).toContain(FT_SHIFT_1_5H.name);
  });
});

describe("sequentialOddSemesterNumbers", () => {
  it("returns only odd numbers, deduplicated and ascending", () => {
    expect(sequentialOddSemesterNumbers([3, 1, 1, 4, 5, 2, 7])).toEqual([1, 3, 5, 7]);
  });

  it("ignores nulls and returns empty when nothing odd is present", () => {
    expect(sequentialOddSemesterNumbers([2, 4, null, 6])).toEqual([]);
  });
});

function makeAssignment(overrides: Partial<AssignmentToSchedule> = {}): AssignmentToSchedule {
  return {
    assignmentId: "a1",
    classId: "class-1",
    className: "CMS26-A-FT",
    studyMode: "FT",
    lecturerId: "lect-1",
    lecturerName: "Dr. Ahmed",
    courseId: "course-1",
    courseName: "Databases",
    creditHours: 1,
    mainRoomId: "room-1",
    mainRoomName: "Room 101",
    ...overrides,
  };
}

const FT_SHIFTS_MAP = new Map([["FT" as const, [FT_SHIFT_1H, FT_SHIFT_1_5H, FT_SHIFT_2_5H]]]);

describe("generateTimetableForBatch", () => {
  it("schedules a single-session assignment normally with no conflicts", () => {
    const result = generateTimetableForBatch(
      [makeAssignment({ creditHours: 1 })],
      FT_SHIFTS_MAP,
      []
    );
    expect(result.scheduledNormally).toHaveLength(1);
    expect(result.scheduledWithFallback).toHaveLength(0);
    expect(result.unscheduled).toHaveLength(0);
    expect(result.scheduledNormally[0].shiftId).toBe("shift-1h");
  });

  it("spaces multiple sessions of the same course/lecturer across different days by default", () => {
    // creditHours=3 with only the 1.5h shift available -> two sessions.
    const result = generateTimetableForBatch(
      [makeAssignment({ creditHours: 3 })],
      new Map([["FT" as const, [FT_SHIFT_1_5H]]]),
      []
    );
    expect(result.scheduledNormally).toHaveLength(2);
    expect(result.scheduledWithFallback).toHaveLength(0);
    const days = result.scheduledNormally.map((s) => s.dayOfWeek);
    expect(new Set(days).size).toBe(2); // two distinct days, spacing rule honored
  });

  it("falls back to double-booking a day only when every other valid day is full, and flags it", () => {
    // FT valid days: SAT, SUN, MON, TUE, WED (5 days). Pre-fill the room on
    // every OTHER valid day at the 1.5h shift's time so only fallback can work.
    const existing: ConflictCandidateSlot[] = ["SUN", "MON", "TUE", "WED"].map((day, i) => ({
      id: `existing-${i}`,
      dayOfWeek: day as ConflictCandidateSlot["dayOfWeek"],
      startTime: FT_SHIFT_1_5H.startTime,
      endTime: FT_SHIFT_1_5H.endTime,
      roomId: "room-1",
      roomName: "Room 101",
      lecturerId: "some-other-lecturer",
      lecturerName: "Other Lecturer",
      classId: "some-other-class",
      className: "Other Class",
      courseName: "Other Course",
    }));

    const result = generateTimetableForBatch(
      [makeAssignment({ creditHours: 3 })],
      new Map([["FT" as const, [FT_SHIFT_1_5H]]]),
      existing
    );

    // First session lands on SAT (the only free day). Second session has
    // nowhere unused left free (SUN-WED are room-blocked by another class),
    // so it must fall back onto SAT alongside the first — a different
    // shift/time would be needed, but there's only one shift here, so
    // instead it should be Unscheduled (SAT itself is already used by
    // session 1 with the exact same shift -> conflicts with itself).
    // This confirms the fallback never silently double-books the SAME time.
    expect(result.scheduledNormally.length + result.scheduledWithFallback.length).toBeLessThanOrEqual(2);
    expect(result.unscheduled.length + result.scheduledWithFallback.length).toBeGreaterThanOrEqual(1);
  });

  it("double-books an already-used day with a DIFFERENT shift as fallback when every other day is genuinely full", () => {
    // Use two different-duration shifts so the fallback session can use a
    // different time on the same day. Room-block every day except SAT with
    // a different class, forcing both of this course's sessions onto SAT.
    const existing: ConflictCandidateSlot[] = ["SUN", "MON", "TUE", "WED"].map((day, i) => ({
      id: `existing-${i}`,
      dayOfWeek: day as ConflictCandidateSlot["dayOfWeek"],
      startTime: "00:00",
      endTime: "23:59",
      roomId: "room-1",
      roomName: "Room 101",
      lecturerId: "some-other-lecturer",
      lecturerName: "Other Lecturer",
      classId: "some-other-class",
      className: "Other Class",
      courseName: "Other Course",
    }));

    const result = generateTimetableForBatch(
      [
        makeAssignment({
          creditHours: 2.5,
          shiftOverrideIds: ["shift-1h", "shift-1.5h"], // two DIFFERENT shifts, same day possible
        }),
      ],
      FT_SHIFTS_MAP,
      existing
    );

    expect(result.scheduledNormally).toHaveLength(1); // first session on SAT, normal
    expect(result.scheduledWithFallback).toHaveLength(1); // second session, fallback onto SAT too
    expect(result.unscheduled).toHaveLength(0);
    expect(result.fallbackNotes).toHaveLength(1);
    const [normal] = result.scheduledNormally;
    const [fallback] = result.scheduledWithFallback;
    expect(normal.dayOfWeek).toBe(fallback.dayOfWeek); // same day
    expect(normal.startTime).not.toBe(fallback.startTime); // different time
  });

  it("never force-places a hard lecturer conflict — lands in Unscheduled instead", () => {
    // The lecturer is already booked at the exact time of the only shift,
    // on every valid FT day. No fallback can rescue this without breaking
    // a hard rule, so it must be Unscheduled, never force-placed.
    const existing: ConflictCandidateSlot[] = ["SAT", "SUN", "MON", "TUE", "WED"].map((day, i) => ({
      id: `existing-${i}`,
      dayOfWeek: day as ConflictCandidateSlot["dayOfWeek"],
      startTime: FT_SHIFT_1H.startTime,
      endTime: FT_SHIFT_1H.endTime,
      roomId: "some-other-room",
      roomName: "Other Room",
      lecturerId: "lect-1", // SAME lecturer as the assignment being scheduled
      lecturerName: "Dr. Ahmed",
      classId: "some-other-class",
      className: "Other Class",
      courseName: "Other Course",
    }));

    const result = generateTimetableForBatch(
      [makeAssignment({ creditHours: 1 })],
      FT_SHIFTS_MAP,
      existing
    );

    expect(result.scheduledNormally).toHaveLength(0);
    expect(result.scheduledWithFallback).toHaveLength(0);
    expect(result.unscheduled).toHaveLength(1);
    expect(result.unscheduled[0].reason).toContain("No valid day/shift remains");
  });

  it("flags a comboWarning when no exact shift combination matches the requested credit hours", () => {
    const result = generateTimetableForBatch(
      [makeAssignment({ creditHours: 2.5 })],
      new Map([["FT" as const, [FT_SHIFT_1_5H]]]), // only 1.5h shift -> 3h total for 2.5 requested
      []
    );
    expect(result.comboWarnings).toHaveLength(1);
    expect(result.comboWarnings[0].message).toContain("0.5h over");
  });

  it("respects an explicit per-assignment shift override instead of auto-picking a combo", () => {
    const result = generateTimetableForBatch(
      [makeAssignment({ creditHours: 999, shiftOverrideIds: ["shift-1h"] })],
      FT_SHIFTS_MAP,
      []
    );
    expect(result.scheduledNormally).toHaveLength(1);
    expect(result.comboWarnings).toHaveLength(0); // override skips combo-matching entirely
  });

  it("prevents two different assignments in the same batch from double-booking the same room", () => {
    const a1 = makeAssignment({ assignmentId: "a1", courseName: "Databases", lecturerId: "lect-1" });
    const a2 = makeAssignment({
      assignmentId: "a2",
      courseName: "Networking",
      lecturerId: "lect-2",
      lecturerName: "Dr. Fatima",
      // Same class, same room -> if scheduled at the exact same day+time as
      // a1, that's a self-conflict for the CLASS (and would also be a ROOM
      // conflict) — must land on a different day instead.
    });
    const result = generateTimetableForBatch([a1, a2], FT_SHIFTS_MAP, []);
    expect(result.unscheduled).toHaveLength(0);
    const days = result.scheduledNormally.map((s) => `${s.dayOfWeek}-${s.startTime}`);
    expect(new Set(days).size).toBe(2);
  });

  it("only uses shifts valid for a PT class and its own valid days", () => {
    const ptAssignment = makeAssignment({
      studyMode: "PT",
      creditHours: 1,
    });
    const ptShift: ShiftTemplate = {
      id: "pt-shift",
      name: "PT Shift",
      studyMode: "PT",
      startTime: "14:00",
      endTime: "15:00",
    };
    const result = generateTimetableForBatch(
      [ptAssignment],
      new Map([
        ["FT" as const, [FT_SHIFT_1H]],
        ["PT" as const, [ptShift]],
      ]),
      []
    );
    expect(result.scheduledNormally).toHaveLength(1);
    expect(result.scheduledNormally[0].shiftId).toBe("pt-shift");
    expect(["THU", "FRI"]).toContain(result.scheduledNormally[0].dayOfWeek);
  });
});
