import { describe, it, expect } from "vitest";
import {
  isValidDayForStudyMode,
  getValidDaysForStudyMode,
  VALID_DAYS_BY_STUDY_MODE,
  formatDayList,
  restrictDaysToLecturerAvailability,
  lecturerAvailabilityConflictReason,
} from "./timetable-days";

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

describe("restrictDaysToLecturerAvailability", () => {
  it("returns the input unchanged when the lecturer has no restriction (empty availableDays)", () => {
    const days: import("@prisma/client").DayOfWeek[] = ["SAT", "SUN", "MON", "TUE", "WED"];
    expect(restrictDaysToLecturerAvailability(days, [])).toEqual(days);
  });

  it("narrows down to exactly the intersection when the lecturer has a restriction", () => {
    expect(restrictDaysToLecturerAvailability(["SAT", "SUN", "MON", "TUE", "WED"], ["SAT", "WED", "THU"])).toEqual([
      "SAT",
      "WED",
    ]);
  });

  it("returns an empty list when there's no overlap at all", () => {
    expect(restrictDaysToLecturerAvailability(["SAT", "SUN", "MON", "TUE", "WED"], ["THU", "FRI"])).toEqual([]);
  });
});

describe("lecturerAvailabilityConflictReason", () => {
  it("returns null (no conflict) for an unrestricted lecturer", () => {
    expect(lecturerAvailabilityConflictReason("FT", [])).toBeNull();
  });

  it("returns null when the restriction has at least a partial overlap with the class's valid days", () => {
    // FT valid days are Sat-Wed; Wed overlaps.
    expect(lecturerAvailabilityConflictReason("FT", ["WED", "THU"])).toBeNull();
  });

  it("returns a specific message when there's ZERO overlap — the row can never be satisfied", () => {
    // FT valid days are Sat-Wed; Thu/Fri never overlap with FT at all.
    const reason = lecturerAvailabilityConflictReason("FT", ["THU", "FRI"]);
    expect(reason).not.toBeNull();
    expect(reason).toContain("Thu/Fri");
    expect(reason).toContain("FT classes meet");
  });

  it("returns null when the class has no studyMode set yet — nothing to evaluate, never guessed", () => {
    expect(lecturerAvailabilityConflictReason(null, ["THU", "FRI"])).toBeNull();
  });

  it("flags a PT class restricted to FT-only days the same way", () => {
    const reason = lecturerAvailabilityConflictReason("PT", ["SAT", "SUN"]);
    expect(reason).not.toBeNull();
    expect(reason).toContain("PT classes meet");
  });
});
