import { describe, it, expect } from "vitest";
import {
  isValidDayForStudyMode,
  getValidDaysForStudyMode,
  VALID_DAYS_BY_STUDY_MODE,
  formatDayList,
  restrictedDaysForLecturer,
  isShiftAllowedForLecturerOnDay,
  formatAvailabilityRules,
  groupLecturerAvailabilityRows,
  lecturerAvailabilityConflictReason,
  type LecturerAvailabilityDayRule,
  type LecturerAvailabilityShiftRef,
} from "./timetable-days";

const subax1: LecturerAvailabilityShiftRef = { id: "shift-1", name: "Subax 1aad", studyMode: "FT", period: "MORNING" };
const subax2: LecturerAvailabilityShiftRef = { id: "shift-2", name: "Subax 2aad", studyMode: "FT", period: "MORNING" };
const galab1: LecturerAvailabilityShiftRef = { id: "shift-3", name: "Galab 1aad", studyMode: "FT", period: "AFTERNOON" };
const ptShift: LecturerAvailabilityShiftRef = { id: "shift-4", name: "PT Shift", studyMode: "PT", period: null };

describe("VALID_DAYS_BY_STUDY_MODE", () => {
  it("FT is Saturday through Wednesday", () => {
    expect(VALID_DAYS_BY_STUDY_MODE.FT).toEqual(["SAT", "SUN", "MON", "TUE", "WED"]);
  });

  it("PT is Thursday and Friday only", () => {
    expect(VALID_DAYS_BY_STUDY_MODE.PT).toEqual(["THU", "FRI"]);
  });
});

describe("isValidDayForStudyMode", () => {
  it("accepts every FT day", () => {
    for (const day of ["SAT", "SUN", "MON", "TUE", "WED"] as const) {
      expect(isValidDayForStudyMode(day, "FT")).toBe(true);
    }
  });

  it("rejects a PT-only day for an FT class", () => {
    expect(isValidDayForStudyMode("THU", "FT")).toBe(false);
    expect(isValidDayForStudyMode("FRI", "FT")).toBe(false);
  });

  it("accepts every PT day", () => {
    expect(isValidDayForStudyMode("THU", "PT")).toBe(true);
    expect(isValidDayForStudyMode("FRI", "PT")).toBe(true);
  });

  it("rejects an FT-only day for a PT class", () => {
    expect(isValidDayForStudyMode("MON", "PT")).toBe(false);
    expect(isValidDayForStudyMode("SAT", "PT")).toBe(false);
  });

  it("allows any day when studyMode is null (legacy/incomplete class data)", () => {
    expect(isValidDayForStudyMode("MON", null)).toBe(true);
    expect(isValidDayForStudyMode("THU", null)).toBe(true);
  });
});

describe("getValidDaysForStudyMode", () => {
  it("returns null for a class with no studyMode set", () => {
    expect(getValidDaysForStudyMode(null)).toBeNull();
  });
});

describe("formatDayList", () => {
  it("formats in the app's Saturday-first week order regardless of input order", () => {
    expect(formatDayList(["WED", "SAT"])).toBe("Sat/Wed");
  });

  it("formats a single day with no separator", () => {
    expect(formatDayList(["WED"])).toBe("Wed");
  });

  it("formats an empty list as an empty string", () => {
    expect(formatDayList([])).toBe("");
  });
});

describe("restrictedDaysForLecturer", () => {
  it("returns the input unchanged when the lecturer has no restriction (empty rules)", () => {
    const days: import("@prisma/client").DayOfWeek[] = ["SAT", "SUN", "MON", "TUE", "WED"];
    expect(restrictedDaysForLecturer(days, [])).toEqual(days);
  });

  it("narrows down to exactly the intersection of rule days when the lecturer has a restriction", () => {
    const rules: LecturerAvailabilityDayRule[] = [
      { dayOfWeek: "SAT", shifts: [] },
      { dayOfWeek: "WED", shifts: [] },
      { dayOfWeek: "THU", shifts: [] },
    ];
    expect(restrictedDaysForLecturer(["SAT", "SUN", "MON", "TUE", "WED"], rules)).toEqual(["SAT", "WED"]);
  });

  it("returns an empty list when there's no overlap at all", () => {
    const rules: LecturerAvailabilityDayRule[] = [{ dayOfWeek: "THU", shifts: [] }, { dayOfWeek: "FRI", shifts: [] }];
    expect(restrictedDaysForLecturer(["SAT", "SUN", "MON", "TUE", "WED"], rules)).toEqual([]);
  });

  it("includes a shift-restricted day in the day-level result too — the shift narrowing is a separate, per-cell question", () => {
    const rules: LecturerAvailabilityDayRule[] = [{ dayOfWeek: "TUE", shifts: [subax1] }];
    expect(restrictedDaysForLecturer(["SAT", "SUN", "MON", "TUE", "WED"], rules)).toEqual(["TUE"]);
  });
});

describe("isShiftAllowedForLecturerOnDay", () => {
  it("always allows any shift for an unrestricted lecturer (empty rules)", () => {
    expect(isShiftAllowedForLecturerOnDay("TUE", "any-shift", [])).toBe(true);
  });

  it("rejects a day with no rule at all", () => {
    const rules: LecturerAvailabilityDayRule[] = [{ dayOfWeek: "SAT", shifts: [] }];
    expect(isShiftAllowedForLecturerOnDay("TUE", subax1.id, rules)).toBe(false);
  });

  it("allows ANY shift on a whole-day rule (empty shifts list)", () => {
    const rules: LecturerAvailabilityDayRule[] = [{ dayOfWeek: "SAT", shifts: [] }];
    expect(isShiftAllowedForLecturerOnDay("SAT", subax1.id, rules)).toBe(true);
    expect(isShiftAllowedForLecturerOnDay("SAT", galab1.id, rules)).toBe(true);
  });

  it("allows only the listed shifts on a shift-restricted day, rejecting others", () => {
    const rules: LecturerAvailabilityDayRule[] = [{ dayOfWeek: "TUE", shifts: [subax1, subax2] }];
    expect(isShiftAllowedForLecturerOnDay("TUE", subax1.id, rules)).toBe(true);
    expect(isShiftAllowedForLecturerOnDay("TUE", subax2.id, rules)).toBe(true);
    expect(isShiftAllowedForLecturerOnDay("TUE", galab1.id, rules)).toBe(false);
  });

  it("keeps different days' shift restrictions fully independent — the exact Tue 1-2 / Sat 2-3 example", () => {
    const rules: LecturerAvailabilityDayRule[] = [
      { dayOfWeek: "TUE", shifts: [subax1, subax2] },
      { dayOfWeek: "SAT", shifts: [subax2, galab1] },
    ];
    expect(isShiftAllowedForLecturerOnDay("TUE", subax1.id, rules)).toBe(true);
    expect(isShiftAllowedForLecturerOnDay("TUE", galab1.id, rules)).toBe(false); // not listed for Tue
    expect(isShiftAllowedForLecturerOnDay("SAT", galab1.id, rules)).toBe(true);
    expect(isShiftAllowedForLecturerOnDay("SAT", subax1.id, rules)).toBe(false); // not listed for Sat
  });
});

describe("formatAvailabilityRules", () => {
  it("formats a whole-day rule with just the day name", () => {
    expect(formatAvailabilityRules([{ dayOfWeek: "SAT", shifts: [] }])).toBe("Sat");
  });

  it("formats a shift-restricted day with its shift names in parentheses", () => {
    expect(formatAvailabilityRules([{ dayOfWeek: "TUE", shifts: [subax1, subax2] }])).toBe("Tue (Subax 1aad, Subax 2aad)");
  });

  it("joins multiple days with 'and', in Saturday-first week order regardless of input order", () => {
    const rules: LecturerAvailabilityDayRule[] = [
      { dayOfWeek: "TUE", shifts: [subax1, subax2] },
      { dayOfWeek: "SAT", shifts: [subax2, galab1] },
    ];
    expect(formatAvailabilityRules(rules)).toBe("Sat (Subax 2aad, Galab 1aad) and Tue (Subax 1aad, Subax 2aad)");
  });

  it("formats an empty rule list as an empty string", () => {
    expect(formatAvailabilityRules([])).toBe("");
  });
});

describe("groupLecturerAvailabilityRows", () => {
  it("groups a day-level-only row (null shift) into an empty shifts list", () => {
    const result = groupLecturerAvailabilityRows([{ dayOfWeek: "SAT", shift: null }]);
    expect(result).toEqual([{ dayOfWeek: "SAT", shifts: [] }]);
  });

  it("groups multiple shift-set rows for the same day into one rule with all shifts", () => {
    const result = groupLecturerAvailabilityRows([
      { dayOfWeek: "TUE", shift: subax1 },
      { dayOfWeek: "TUE", shift: subax2 },
    ]);
    expect(result).toEqual([{ dayOfWeek: "TUE", shifts: [subax1, subax2] }]);
  });

  it("keeps different days as separate rules", () => {
    const result = groupLecturerAvailabilityRows([
      { dayOfWeek: "TUE", shift: subax1 },
      { dayOfWeek: "SAT", shift: null },
    ]);
    expect(result).toEqual([
      { dayOfWeek: "TUE", shifts: [subax1] },
      { dayOfWeek: "SAT", shifts: [] },
    ]);
  });

  it("returns an empty array for no rows at all — fully unrestricted", () => {
    expect(groupLecturerAvailabilityRows([])).toEqual([]);
  });
});

describe("lecturerAvailabilityConflictReason", () => {
  it("returns null (no conflict) for an unrestricted lecturer", () => {
    expect(lecturerAvailabilityConflictReason("FT", "MORNING", [])).toBeNull();
  });

  it("returns null when a day-level restriction has at least a partial overlap with the class's valid days", () => {
    // FT valid days are Sat-Wed; Wed overlaps.
    const rules: LecturerAvailabilityDayRule[] = [{ dayOfWeek: "WED", shifts: [] }, { dayOfWeek: "THU", shifts: [] }];
    expect(lecturerAvailabilityConflictReason("FT", "MORNING", rules)).toBeNull();
  });

  it("returns a specific message when there's ZERO day overlap — the row can never be satisfied", () => {
    // FT valid days are Sat-Wed; Thu/Fri never overlap with FT at all.
    const rules: LecturerAvailabilityDayRule[] = [{ dayOfWeek: "THU", shifts: [] }, { dayOfWeek: "FRI", shifts: [] }];
    const reason = lecturerAvailabilityConflictReason("FT", "MORNING", rules);
    expect(reason).not.toBeNull();
    expect(reason).toContain("Thu and Fri");
    expect(reason).toContain("FT classes meet");
  });

  it("returns null when the class has no studyMode set yet — nothing to evaluate, never guessed", () => {
    const rules: LecturerAvailabilityDayRule[] = [{ dayOfWeek: "THU", shifts: [] }];
    expect(lecturerAvailabilityConflictReason(null, null, rules)).toBeNull();
  });

  it("flags a PT class restricted to FT-only days the same way", () => {
    const rules: LecturerAvailabilityDayRule[] = [{ dayOfWeek: "SAT", shifts: [] }, { dayOfWeek: "SUN", shifts: [] }];
    const reason = lecturerAvailabilityConflictReason("PT", null, rules);
    expect(reason).not.toBeNull();
    expect(reason).toContain("PT classes meet");
  });

  it("returns null when a day overlaps AND its shift restriction includes a shift matching the class's studyMode/period", () => {
    const rules: LecturerAvailabilityDayRule[] = [{ dayOfWeek: "TUE", shifts: [subax1] }];
    expect(lecturerAvailabilityConflictReason("FT", "MORNING", rules)).toBeNull();
  });

  it("flags a day-overlapping row whose shift restriction excludes every shift matching the class's studyMode/period", () => {
    // Day overlaps (TUE is a valid FT day), but the only listed shift for
    // that day is an Afternoon shift while the class is Morning — no
    // combination could ever work.
    const rules: LecturerAvailabilityDayRule[] = [{ dayOfWeek: "TUE", shifts: [galab1] }];
    const reason = lecturerAvailabilityConflictReason("FT", "MORNING", rules);
    expect(reason).not.toBeNull();
    expect(reason).toContain("none of the shifts");
  });

  it("does not flag when the shift restriction matches a PT class (no period)", () => {
    const rules: LecturerAvailabilityDayRule[] = [{ dayOfWeek: "THU", shifts: [ptShift] }];
    expect(lecturerAvailabilityConflictReason("PT", null, rules)).toBeNull();
  });
});
