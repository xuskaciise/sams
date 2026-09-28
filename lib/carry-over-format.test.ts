import { describe, it, expect } from "vitest";
import {
  combineCarryOverTotals,
  formatCarriedOverMark,
  formatCarriedOverValue,
  type CarriedOverSource,
} from "./carry-over-format";

function source(marks: { title: string; mark: number | null; max: number; att?: string }[]): CarriedOverSource {
  const m = marks.map((x, i) => ({
    assessmentId: `a${i}`,
    title: x.title,
    typeName: "Quiz",
    mark: x.mark,
    maximumMarks: x.max,
    attendanceStatus: x.att ?? "PRESENT",
    isCorrected: false,
  }));
  return {
    enrollmentId: "old",
    classLabel: "CMS-3A",
    lecturerName: "Dr. Old",
    semesterName: "Semester 1",
    marks: m,
    earned: m.reduce((s, x) => s + (x.mark ?? 0), 0),
    possible: m.reduce((s, x) => s + x.maximumMarks, 0),
  };
}

describe("combineCarryOverTotals", () => {
  it("reports carried marks as their own subtotal and combines only when titles don't overlap", () => {
    const totals = combineCarryOverTotals(
      { earned: 15, possible: 20, titles: ["Midterm"] },
      [source([{ title: "Quiz 1", mark: 8.5, max: 10 }])]
    );
    expect(totals).toEqual({
      carriedEarned: 8.5,
      carriedPossible: 10,
      combined: { earned: 23.5, possible: 30 },
      combinedHiddenReason: null,
    });
  });

  it("hides the combined total when the same assessment title exists in both classes (possible double count)", () => {
    const totals = combineCarryOverTotals(
      { earned: 9, possible: 10, titles: [" quiz 1 "] },
      [source([{ title: "Quiz 1", mark: 8.5, max: 10 }])]
    );
    expect(totals.combined).toBeNull();
    expect(totals.carriedEarned).toBe(8.5);
    expect(totals.combinedHiddenReason).toMatch(/“Quiz 1”/);
  });

  it("returns no combined figure when nothing was carried over", () => {
    expect(combineCarryOverTotals({ earned: 1, possible: 2, titles: [] }, [])).toEqual({
      carriedEarned: 0,
      carriedPossible: 0,
      combined: null,
      combinedHiddenReason: null,
    });
  });

  it("counts an absent/exempt carried mark as 0 earned", () => {
    const totals = combineCarryOverTotals(
      { earned: 0, possible: 0, titles: [] },
      [source([{ title: "Lab", mark: null, max: 5, att: "ABSENT" }])]
    );
    expect(totals.carriedEarned).toBe(0);
    expect(totals.carriedPossible).toBe(5);
  });
});

describe("formatCarriedOverMark", () => {
  it("formats marks and attendance", () => {
    const [present, absent] = source([
      { title: "Quiz 1", mark: 8.5, max: 10 },
      { title: "Lab", mark: null, max: 5, att: "ABSENT" },
    ]).marks;
    expect(formatCarriedOverMark(present)).toBe("Quiz 1: 8.5/10");
    expect(formatCarriedOverValue(absent)).toBe("Absent");
  });
});
