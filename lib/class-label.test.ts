import { describe, it, expect } from "vitest";
import { formatClassLabel } from "./class-label";

describe("formatClassLabel", () => {
  it("appends the current semester number", () => {
    expect(formatClassLabel({ name: "CMS-A", currentSemesterNumber: 1 })).toBe(
      "CMS-A (Semester 1)"
    );
  });

  it("falls back to the plain name when currentSemesterNumber is null", () => {
    expect(formatClassLabel({ name: "CMS-A", currentSemesterNumber: null })).toBe(
      "CMS-A"
    );
  });

  it("never mutates or reformats the underlying name itself", () => {
    expect(
      formatClassLabel({ name: "CMS26-A-PT", currentSemesterNumber: 3 })
    ).toBe("CMS26-A-PT (Semester 3)");
  });
});
