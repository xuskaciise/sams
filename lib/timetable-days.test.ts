import { describe, it, expect } from "vitest";
import {
  isValidDayForStudyMode,
  getValidDaysForStudyMode,
  VALID_DAYS_BY_STUDY_MODE,
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
