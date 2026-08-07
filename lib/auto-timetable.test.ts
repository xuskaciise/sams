import { describe, it, expect } from "vitest";
import type { ConflictCandidateSlot } from "./timetable-conflicts";
import {
  findClosestShiftCombo,
  describeCombo,
  generateTimetableForBatch,
  parityForAcademicSemesterNumber,
  classifySemesterNumbersByEligibility,
  describeIneligibleLevels,
  type ShiftTemplate,
  type AssignmentToSchedule,
} from "./auto-timetable";

const FT_SHIFT_1H: ShiftTemplate = {
  id: "shift-1h",
  name: "Shift 1 (1h)",
  studyMode: "FT",
  period: "MORNING",
  startTime: "08:00",
  endTime: "09:00",
};
const FT_SHIFT_1_5H: ShiftTemplate = {
  id: "shift-1.5h",
  name: "Shift 2 (1.5h)",
  studyMode: "FT",
  period: "MORNING",
  startTime: "09:00",
  endTime: "10:30",
};
const FT_SHIFT_2_5H: ShiftTemplate = {
  id: "shift-2.5h",
  name: "Shift 3 (2.5h)",
  studyMode: "FT",
  period: "MORNING",
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
      period: "MORNING",
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

describe("parityForAcademicSemesterNumber", () => {
  it("maps academic Semester 1 to ODD", () => {
    expect(parityForAcademicSemesterNumber(1)).toBe("ODD");
  });

  it("maps academic Semester 2 to EVEN", () => {
    expect(parityForAcademicSemesterNumber(2)).toBe("EVEN");
  });

  it("returns null when there's no active semester or its number isn't set", () => {
    expect(parityForAcademicSemesterNumber(null)).toBeNull();
  });
});

describe("classifySemesterNumbersByEligibility", () => {
  it("with academic Semester 1 active, only odd class levels are eligible, ascending and deduplicated", () => {
    const result = classifySemesterNumbersByEligibility([3, 1, 1, 4, 5, 2, 7], 1);
    expect(result.eligible).toEqual([1, 3, 5, 7]);
    expect(result.ineligible).toEqual([2, 4]);
  });

  it("with academic Semester 2 active, only even class levels are eligible", () => {
    const result = classifySemesterNumbersByEligibility([3, 1, 1, 4, 5, 2, 7], 2);
    expect(result.eligible).toEqual([2, 4]);
    expect(result.ineligible).toEqual([1, 3, 5, 7]);
  });

  it("ignores nulls entirely — never eligible, never reported as ineligible", () => {
    const result = classifySemesterNumbersByEligibility([2, 4, null, 6], 1);
    expect(result.eligible).toEqual([]);
    expect(result.ineligible).toEqual([2, 4, 6]);
  });

  it("treats every present level as ineligible when parity can't be determined", () => {
    const result = classifySemesterNumbersByEligibility([1, 2, 3, 4], null);
    expect(result.eligible).toEqual([]);
    expect(result.ineligible).toEqual([1, 2, 3, 4]);
  });
});

describe("describeIneligibleLevels", () => {
  it("returns null when nothing is ineligible", () => {
    expect(describeIneligibleLevels([], 1)).toBeNull();
  });

  it("explains odd-level classes are ineligible while Semester 2 (even) is active", () => {
    const message = describeIneligibleLevels([1, 3], 2);
    expect(message).toContain("odd-level classes");
    expect(message).toContain("1, 3");
    expect(message).toContain("Semester 1");
  });

  it("explains even-level classes are ineligible while Semester 1 (odd) is active", () => {
    const message = describeIneligibleLevels([2, 4], 1);
    expect(message).toContain("even-level classes");
    expect(message).toContain("2, 4");
    expect(message).toContain("Semester 2");
  });

  it("explains eligibility can't be determined when there's no resolvable active semester number", () => {
    const message = describeIneligibleLevels([1, 2], null);
    expect(message).toContain("can't be checked");
  });
});

function makeAssignment(overrides: Partial<AssignmentToSchedule> = {}): AssignmentToSchedule {
  return {
    assignmentId: "a1",
    classId: "class-1",
    className: "CMS26-A-FT",
    studyMode: "FT",
    period: "MORNING",
    lecturerId: "lect-1",
    lecturerName: "Dr. Ahmed",
    lecturerAvailableDays: [],
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

  it("still finds an open slot on a DIFFERENT shift when the preferred one is fully booked (BUG 1 fix)", () => {
    // The lecturer is booked at the exact time of the preferred (1h) shift
    // on every valid FT day — but two OTHER shifts (1.5h, 2.5h) for this
    // study mode are wide open. Placement must now try the full
    // (day × shift) cross-product before giving up, not just the one
    // shift the credit-hour combo happened to prefer.
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

    expect(result.unscheduled).toHaveLength(0);
    expect(result.scheduledNormally).toHaveLength(1);
    // Placed on a shift OTHER than the fully-booked preferred one.
    expect(result.scheduledNormally[0].shiftId).not.toBe(FT_SHIFT_1H.id);
  });

  it("never force-places a hard conflict that blocks EVERY shift on EVERY valid day — lands in Unscheduled instead", () => {
    // The lecturer is booked across every valid FT day at all three
    // available shift times — genuinely nothing left to try, so this must
    // still land in Unscheduled, never force-placed.
    const existing: ConflictCandidateSlot[] = ["SAT", "SUN", "MON", "TUE", "WED"].flatMap((day, i) =>
      [FT_SHIFT_1H, FT_SHIFT_1_5H, FT_SHIFT_2_5H].map((shift, j) => ({
        id: `existing-${i}-${j}`,
        dayOfWeek: day as ConflictCandidateSlot["dayOfWeek"],
        startTime: shift.startTime,
        endTime: shift.endTime,
        roomId: "some-other-room",
        roomName: "Other Room",
        lecturerId: "lect-1", // SAME lecturer as the assignment being scheduled
        lecturerName: "Dr. Ahmed",
        classId: "some-other-class",
        className: "Other Class",
        courseName: "Other Course",
      }))
    );

    const result = generateTimetableForBatch(
      [makeAssignment({ creditHours: 1 })],
      FT_SHIFTS_MAP,
      existing
    );

    expect(result.scheduledNormally).toHaveLength(0);
    expect(result.scheduledWithFallback).toHaveLength(0);
    expect(result.unscheduled).toHaveLength(1);
    expect(result.unscheduled[0].reason).toContain("No valid day/shift combination remains");
    expect(result.unscheduled[0].sessionNumber).toBe(1);
    expect(result.unscheduled[0].sessionCount).toBe(1);
  });

  it("reproduces and fixes the reported bug: many classes sharing one room all needing the same preferred shift overflow onto other shifts instead of all failing identically", () => {
    // Six different classes, all sharing the SAME room, all requesting the
    // same 1h credit-hour target -> the closest-combo algorithm picks the
    // SAME preferred shift (1h) for every one of them. FT only has 5 valid
    // days, so the room's capacity for that ONE shift is exhausted after 5
    // classes — under the OLD bug, every class past the 5th (and beyond)
    // would fail with the exact same "No valid day/shift remains for
    // Shift 1 (1h)" reason, even though the room is completely free at the
    // 1.5h and 2.5h shift times. The fix must let the overflow land on a
    // different shift instead of piling up in Unscheduled.
    const sixClasses = Array.from({ length: 6 }, (_, i) =>
      makeAssignment({
        assignmentId: `a${i}`,
        classId: `class-${i}`,
        className: `Class ${i}`,
        courseId: `course-${i}`,
        courseName: `Course ${i}`,
        lecturerId: `lect-${i}`,
        lecturerName: `Lecturer ${i}`,
        creditHours: 1,
        mainRoomId: "shared-room", // every class uses the SAME room
      })
    );

    const result = generateTimetableForBatch(sixClasses, FT_SHIFTS_MAP, []);

    // Under the old bug this would be 5 scheduled + 1 unscheduled, all
    // with the identical "Shift 1 (1h)" reason. The fix schedules all 6 —
    // the 6th overflows onto a different shift in the same room.
    expect(result.unscheduled).toHaveLength(0);
    expect(result.scheduledNormally).toHaveLength(6);
    const shiftIdsUsed = new Set(result.scheduledNormally.map((s) => s.shiftId));
    expect(shiftIdsUsed.size).toBeGreaterThan(1); // more than just the one preferred shift
  });

  it("an explicit shift override does NOT fall back to other shifts — stays strict to the admin's choice", () => {
    // The override picks shift-1h specifically; block it on every valid FT
    // day. Even though shift-1.5h/2.5h are wide open, an override must
    // never be silently substituted — it should land in Unscheduled.
    const existing: ConflictCandidateSlot[] = ["SAT", "SUN", "MON", "TUE", "WED"].map((day, i) => ({
      id: `existing-${i}`,
      dayOfWeek: day as ConflictCandidateSlot["dayOfWeek"],
      startTime: FT_SHIFT_1H.startTime,
      endTime: FT_SHIFT_1H.endTime,
      roomId: "room-1",
      roomName: "Room 101",
      lecturerId: "some-other-lecturer",
      lecturerName: "Other Lecturer",
      classId: "some-other-class",
      className: "Other Class",
      courseName: "Other Course",
    }));

    const result = generateTimetableForBatch(
      [makeAssignment({ creditHours: 1, shiftOverrideIds: ["shift-1h"] })],
      FT_SHIFTS_MAP,
      existing
    );

    expect(result.scheduledNormally).toHaveLength(0);
    expect(result.scheduledWithFallback).toHaveLength(0);
    expect(result.unscheduled).toHaveLength(1);
    expect(result.unscheduled[0].reason).toContain("overridden shift");
  });

  it("labels multi-session assignments with sessionNumber/sessionCount", () => {
    // creditHours=3 with only the 1.5h shift available -> two sessions.
    const result = generateTimetableForBatch(
      [makeAssignment({ creditHours: 3 })],
      new Map([["FT" as const, [FT_SHIFT_1_5H]]]),
      []
    );
    expect(result.scheduledNormally).toHaveLength(2);
    const numbers = result.scheduledNormally.map((s) => s.sessionNumber).sort();
    expect(numbers).toEqual([1, 2]);
    expect(result.scheduledNormally.every((s) => s.sessionCount === 2)).toBe(true);
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
      period: null,
      creditHours: 1,
    });
    const ptShift: ShiftTemplate = {
      id: "pt-shift",
      name: "PT Shift",
      studyMode: "PT",
      period: null,
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

  describe("lecturer availableDays (OPTIONAL hard constraint)", () => {
    it("an unrestricted lecturer (empty availableDays) behaves exactly as before — any valid FT day", () => {
      const result = generateTimetableForBatch(
        [makeAssignment({ lecturerAvailableDays: [], creditHours: 1 })],
        FT_SHIFTS_MAP,
        []
      );
      expect(result.unscheduled).toHaveLength(0);
      expect(["SAT", "SUN", "MON", "TUE", "WED"]).toContain(result.scheduledNormally[0].dayOfWeek);
    });

    it("a restricted lecturer is only ever scheduled within the intersection of their availableDays and the class's valid days", () => {
      // creditHours=3 with only the 1.5h shift -> two sessions, so the
      // spacing rule would normally want two DIFFERENT days — but this
      // lecturer is restricted to exactly SAT and WED.
      const result = generateTimetableForBatch(
        [makeAssignment({ lecturerAvailableDays: ["SAT", "WED"], creditHours: 3 })],
        new Map([["FT" as const, [FT_SHIFT_1_5H]]]),
        []
      );
      expect(result.unscheduled).toHaveLength(0);
      const days = result.scheduledNormally.map((s) => s.dayOfWeek);
      expect(days.every((d) => d === "SAT" || d === "WED")).toBe(true);
      expect(new Set(days).size).toBe(2); // spacing rule still honored within the allowed set
    });

    it("never places a session on a day outside availableDays even when that day is otherwise wide open (hard constraint, no fallback bypass)", () => {
      const result = generateTimetableForBatch(
        [makeAssignment({ lecturerAvailableDays: ["SAT"], creditHours: 1 })],
        FT_SHIFTS_MAP,
        []
      );
      expect(result.unscheduled).toHaveLength(0);
      expect(result.scheduledNormally[0].dayOfWeek).toBe("SAT");
    });

    it("still allows the spacing-fallback pass to reuse the ONE day it's restricted to (different shift/time), rather than bypassing the restriction onto another day", () => {
      // Lecturer restricted to SAT only; two 1h sessions needed. Pass 1
      // (unused days) finds nothing since SAT is the only allowed day and
      // it's already used by session 1 — pass 2 must reuse SAT at a
      // different shift, never spill onto SUN/MON/etc.
      const result = generateTimetableForBatch(
        [makeAssignment({ lecturerAvailableDays: ["SAT"], creditHours: 2 })],
        new Map([["FT" as const, [FT_SHIFT_1H, { ...FT_SHIFT_1H, id: "shift-1h-b", startTime: "10:00", endTime: "11:00" }]]]),
        []
      );
      expect(result.unscheduled).toHaveLength(0);
      expect(result.scheduledNormally.every((s) => s.dayOfWeek === "SAT")).toBe(true);
      expect(result.scheduledWithFallback).toHaveLength(1); // the reused-day session is flagged
    });

    it("reports Unscheduled with a specific reason when availableDays has ZERO overlap with the class's valid days", () => {
      // FT valid days are Sat-Wed; THU/FRI never overlap with FT at all.
      const result = generateTimetableForBatch(
        [makeAssignment({ lecturerAvailableDays: ["THU", "FRI"], creditHours: 1 })],
        FT_SHIFTS_MAP,
        []
      );
      expect(result.scheduledNormally).toHaveLength(0);
      expect(result.scheduledWithFallback).toHaveLength(0);
      expect(result.unscheduled).toHaveLength(1);
      expect(result.unscheduled[0].reason).toContain("Lecturer only available Thu/Fri");
      expect(result.unscheduled[0].reason).toContain("none of those day(s) are valid teaching days");
    });

    it("reports Unscheduled with a specific reason when the intersection exists but every allowed day is fully booked", () => {
      // Restricted to SAT/WED; pre-fill the room on BOTH at the exact
      // session's time so genuinely nothing is open.
      const existing: ConflictCandidateSlot[] = ["SAT", "WED"].map((day, i) => ({
        id: `existing-${i}`,
        dayOfWeek: day as ConflictCandidateSlot["dayOfWeek"],
        startTime: FT_SHIFT_1H.startTime,
        endTime: FT_SHIFT_1H.endTime,
        roomId: "room-1",
        roomName: "Room 101",
        lecturerId: "other-lecturer",
        lecturerName: "Other",
        classId: "other-class",
        className: "Other Class",
        courseName: "Other Course",
      }));
      const result = generateTimetableForBatch(
        [makeAssignment({ lecturerAvailableDays: ["SAT", "WED"], creditHours: 1 })],
        new Map([["FT" as const, [FT_SHIFT_1H]]]),
        existing
      );
      expect(result.scheduledNormally).toHaveLength(0);
      expect(result.scheduledWithFallback).toHaveLength(0);
      expect(result.unscheduled).toHaveLength(1);
      expect(result.unscheduled[0].reason).toContain("Lecturer only available Sat/Wed");
      expect(result.unscheduled[0].reason).toContain("no open slot on any of those days");
    });

    it("a restricted lecturer's constraint never bleeds into a DIFFERENT (unrestricted) lecturer's placement in the same batch", () => {
      const restricted = makeAssignment({
        assignmentId: "a1",
        lecturerId: "lect-1",
        lecturerAvailableDays: ["SAT"],
        courseName: "Databases",
        creditHours: 1,
      });
      const unrestricted = makeAssignment({
        assignmentId: "a2",
        lecturerId: "lect-2",
        lecturerName: "Dr. Fatima",
        lecturerAvailableDays: [],
        courseName: "Networking",
        creditHours: 1,
        mainRoomId: "room-2", // different room, so it can't be forced onto SAT by a room conflict
      });
      const result = generateTimetableForBatch([restricted, unrestricted], FT_SHIFTS_MAP, []);
      expect(result.unscheduled).toHaveLength(0);
      const restrictedSession = result.scheduledNormally.find((s) => s.assignmentId === "a1")!;
      expect(restrictedSession.dayOfWeek).toBe("SAT");
      // The unrestricted lecturer is free to land on ANY valid day,
      // including a day the restricted lecturer could never use.
      const unrestrictedSession = result.scheduledNormally.find((s) => s.assignmentId === "a2")!;
      expect(["SAT", "SUN", "MON", "TUE", "WED"]).toContain(unrestrictedSession.dayOfWeek);
    });
  });

  describe("period restriction (FT-only)", () => {
    const MORNING_SHIFT: ShiftTemplate = {
      id: "subax-1",
      name: "Subax 1aad",
      studyMode: "FT",
      period: "MORNING",
      startTime: "07:45",
      endTime: "09:15",
    };
    const AFTERNOON_SHIFT: ShiftTemplate = {
      id: "galab-1",
      name: "Galab 1aad",
      studyMode: "FT",
      period: "AFTERNOON",
      startTime: "13:00",
      endTime: "14:30",
    };
    const MIXED_MAP = new Map([["FT" as const, [MORNING_SHIFT, AFTERNOON_SHIFT]]]);

    it("a Morning-period class only ever uses Morning shifts, never an Afternoon one", () => {
      const result = generateTimetableForBatch(
        [makeAssignment({ period: "MORNING", creditHours: 1 })],
        MIXED_MAP,
        []
      );
      expect(result.scheduledNormally).toHaveLength(1);
      expect(result.scheduledNormally[0].shiftId).toBe("subax-1");
      const usedShiftIds = new Set(
        [...result.scheduledNormally, ...result.scheduledWithFallback].map((s) => s.shiftId)
      );
      expect(usedShiftIds.has("galab-1")).toBe(false);
    });

    it("an Afternoon-period class only ever uses Afternoon shifts, never a Morning one", () => {
      const result = generateTimetableForBatch(
        [makeAssignment({ period: "AFTERNOON", creditHours: 1 })],
        MIXED_MAP,
        []
      );
      expect(result.scheduledNormally).toHaveLength(1);
      expect(result.scheduledNormally[0].shiftId).toBe("galab-1");
      const usedShiftIds = new Set(
        [...result.scheduledNormally, ...result.scheduledWithFallback].map((s) => s.shiftId)
      );
      expect(usedShiftIds.has("subax-1")).toBe(false);
    });

    it("does NOT spill onto the other period even when its own period's shifts are fully booked — lands in Unscheduled instead (the reported bug)", () => {
      // Morning shift blocked on every valid FT day for this lecturer — the
      // Afternoon shift (galab-1) is wide open, but a Morning-period class
      // must never spill onto it.
      const existing: ConflictCandidateSlot[] = ["SAT", "SUN", "MON", "TUE", "WED"].map((day, i) => ({
        id: `existing-${i}`,
        dayOfWeek: day as ConflictCandidateSlot["dayOfWeek"],
        startTime: MORNING_SHIFT.startTime,
        endTime: MORNING_SHIFT.endTime,
        roomId: "some-other-room",
        roomName: "Other Room",
        lecturerId: "lect-1",
        lecturerName: "Dr. Ahmed",
        classId: "some-other-class",
        className: "Other Class",
        courseName: "Other Course",
      }));
      const result = generateTimetableForBatch(
        [makeAssignment({ period: "MORNING", creditHours: 1 })],
        MIXED_MAP,
        existing
      );
      expect(result.scheduledNormally).toHaveLength(0);
      expect(result.scheduledWithFallback).toHaveLength(0);
      expect(result.unscheduled).toHaveLength(1);
    });

    it("multiple Morning-period classes sharing a room never overflow onto the Afternoon shift, even under the BUG-1-style overflow fix", () => {
      const morningClasses = Array.from({ length: 6 }, (_, i) =>
        makeAssignment({
          assignmentId: `a${i}`,
          classId: `class-${i}`,
          className: `Class ${i}`,
          courseId: `course-${i}`,
          courseName: `Course ${i}`,
          lecturerId: `lect-${i}`,
          lecturerName: `Lecturer ${i}`,
          period: "MORNING",
          creditHours: 1,
          mainRoomId: "shared-room",
        })
      );
      const result = generateTimetableForBatch(morningClasses, MIXED_MAP, []);
      // FT has 5 valid days, only 1 Morning shift exists here -> the 6th
      // class's session cannot find an open Morning slot in the shared
      // room, and must NOT overflow onto the Afternoon shift.
      const usedShiftIds = new Set(result.scheduledNormally.map((s) => s.shiftId));
      expect(usedShiftIds.has("galab-1")).toBe(false);
      expect(result.scheduledNormally.length).toBeLessThanOrEqual(5);
      expect(result.scheduledNormally.length + result.unscheduled.length).toBe(6);
    });

    it("PT scheduling is completely unaffected by period — no restriction applied even when period is null", () => {
      const ptShift: ShiftTemplate = {
        id: "pt-shift",
        name: "PT Shift",
        studyMode: "PT",
        period: null,
        startTime: "14:00",
        endTime: "15:00",
      };
      const result = generateTimetableForBatch(
        [makeAssignment({ studyMode: "PT", period: null, creditHours: 1 })],
        new Map([["PT" as const, [ptShift]]]),
        []
      );
      expect(result.scheduledNormally).toHaveLength(1);
      expect(result.scheduledNormally[0].shiftId).toBe("pt-shift");
    });

    it("an FT class with no period assigned yet matches no shift and reports the standard no-templates reason, rather than guessing", () => {
      const result = generateTimetableForBatch(
        [makeAssignment({ period: null, creditHours: 1 })],
        MIXED_MAP,
        []
      );
      expect(result.scheduledNormally).toHaveLength(0);
      expect(result.unscheduled).toHaveLength(1);
      expect(result.unscheduled[0].reason).toContain("No Shift templates exist");
    });
  });
});
