import { describe, it, expect } from "vitest";
import {
  carryOverSubtotal,
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

describe("carryOverSubtotal", () => {
  it("sums carried marks into their own subtotal only — there is no combined figure", () => {
    const subtotal = carryOverSubtotal([source([{ title: "Quiz 1", mark: 8.5, max: 10 }])]);
    expect(subtotal).toEqual({ earned: 8.5, possible: 10 });
    expect(subtotal).not.toHaveProperty("combined");
  });

  it("sums across several predecessor sources", () => {
    expect(
      carryOverSubtotal([
        source([{ title: "Quiz 1", mark: 8, max: 10 }]),
        source([{ title: "Lab", mark: 4, max: 5 }]),
      ])
    ).toEqual({ earned: 12, possible: 15 });
  });

  it("is zero when nothing was carried over", () => {
    expect(carryOverSubtotal([])).toEqual({ earned: 0, possible: 0 });
  });

  it("counts an absent/exempt carried mark as 0 earned", () => {
    expect(
      carryOverSubtotal([source([{ title: "Lab", mark: null, max: 5, att: "ABSENT" }])])
    ).toEqual({ earned: 0, possible: 5 });
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
