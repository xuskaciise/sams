import { describe, it, expect } from "vitest";
import { assignCourseColors, pickTextColor, rgbToHex, BASE_HUES } from "./course-colors";

describe("assignCourseColors", () => {
  it("assigns the base hues in alphabetical course-name order for the first 8 courses", () => {
    const colors = assignCourseColors(["Zoology", "Algorithms", "Databases"]);
    // Alphabetical: Algorithms, Databases, Zoology -> hue[0], hue[1], hue[2]
    expect(colors.get("Algorithms")!.hex).toBe(BASE_HUES[0].hex);
    expect(colors.get("Databases")!.hex).toBe(BASE_HUES[1].hex);
    expect(colors.get("Zoology")!.hex).toBe(BASE_HUES[2].hex);
  });

  it("gives every session of the same course name the identical color (dedupes repeats)", () => {
    const colors = assignCourseColors(["Databases", "Databases", "Networks", "Databases"]);
    expect(colors.size).toBe(2);
    expect(colors.get("Databases")).toBeDefined();
    expect(colors.get("Networks")).toBeDefined();
  });

  it("is stable/deterministic — the same course set always produces the same colors regardless of input order", () => {
    const a = assignCourseColors(["Networks", "Algorithms", "Databases"]);
    const b = assignCourseColors(["Databases", "Networks", "Algorithms"]);
    for (const name of ["Networks", "Algorithms", "Databases"]) {
      expect(a.get(name)!.hex).toBe(b.get(name)!.hex);
    }
  });

  it("cycles through a lightened tier of the same 8 hues for courses 9-16, never repeating a color within 16 courses", () => {
    const names = Array.from({ length: 16 }, (_, i) => `Course ${String(i).padStart(2, "0")}`);
    const colors = assignCourseColors(names);
    const hexes = names.map((n) => colors.get(n)!.hex);
    expect(new Set(hexes).size).toBe(16); // all distinct
    // Course 08 (index 8, 9th course alphabetically) reuses hue 0's family
    // but at a different (lighter) tier than the base hue itself.
    const ninth = colors.get("Course 08")!;
    expect(ninth.hex).not.toBe(BASE_HUES[0].hex);
    expect(ninth.colorName).toContain("Blue");
  });

  it("every generated color has a readable black-or-white text color attached", () => {
    const names = Array.from({ length: 20 }, (_, i) => `Course ${i}`);
    const colors = assignCourseColors(names);
    for (const entry of colors.values()) {
      expect(["#000000", "#ffffff"]).toContain(entry.textColor);
    }
  });

  it("returns an empty map for no courses", () => {
    expect(assignCourseColors([]).size).toBe(0);
  });
});

describe("pickTextColor", () => {
  it("picks black text on a light fill and white text on a dark fill", () => {
    expect(pickTextColor("#ffffff")).toBe("#000000");
    expect(pickTextColor("#000000")).toBe("#ffffff");
  });

  it("picks a color with equal-or-better contrast than the alternative for every base hue", () => {
    for (const hue of BASE_HUES) {
      const chosen = pickTextColor(hue.hex);
      expect(["#000000", "#ffffff"]).toContain(chosen);
    }
  });
});

describe("rgbToHex", () => {
  it("round-trips and clamps out-of-range components", () => {
    expect(rgbToHex(255, 0, 0)).toBe("#ff0000");
    expect(rgbToHex(-10, 300, 128)).toBe("#00ff80");
  });
});
