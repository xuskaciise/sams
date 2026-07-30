import { describe, it, expect } from "vitest";
import {
  WHATSAPP_TEMPLATE_PLACEHOLDERS,
  DEFAULT_WHATSAPP_TEMPLATES,
  findUnknownPlaceholders,
  fillTemplate,
} from "./whatsapp-templates";

describe("findUnknownPlaceholders", () => {
  it("returns an empty array when every placeholder is known for that event type", () => {
    expect(
      findUnknownPlaceholders("RESULTS_PUBLISHED", "Hello {studentName}, you scored {mark}")
    ).toEqual([]);
  });

  it("flags a typo'd placeholder (e.g. {studnetName})", () => {
    expect(findUnknownPlaceholders("RESULTS_PUBLISHED", "Hello {studnetName}")).toEqual([
      "studnetName",
    ]);
  });

  it("flags a placeholder that's valid for a DIFFERENT event type but not this one", () => {
    // {changeSummary} only exists for TIMETABLE_CHANGE.
    expect(findUnknownPlaceholders("RESULTS_PUBLISHED", "{changeSummary}")).toEqual([
      "changeSummary",
    ]);
  });

  it("de-duplicates repeated unknown placeholders", () => {
    expect(findUnknownPlaceholders("RESULTS_PUBLISHED", "{oops} and {oops} again")).toEqual([
      "oops",
    ]);
  });

  it("every seeded default template uses only known placeholders for its own event type", () => {
    for (const [eventType, text] of Object.entries(DEFAULT_WHATSAPP_TEMPLATES)) {
      expect(findUnknownPlaceholders(eventType as never, text)).toEqual([]);
    }
  });
});

describe("fillTemplate", () => {
  it("substitutes every known placeholder", () => {
    expect(fillTemplate("Hello {studentName}, {mark}", { studentName: "Amina", mark: "18" })).toBe(
      "Hello Amina, 18"
    );
  });

  it("leaves an unrecognized {token} untouched rather than guessing", () => {
    expect(fillTemplate("Hello {studentName}, {unknown}", { studentName: "Amina" })).toBe(
      "Hello Amina, {unknown}"
    );
  });

  it("substitutes repeated occurrences of the same placeholder", () => {
    expect(fillTemplate("{name} {name}", { name: "Amina" })).toBe("Amina Amina");
  });

  it("reproduces LEAVE_NOTICE's original conditional-dash behavior via a pre-composed description value", () => {
    const withDescription = fillTemplate(DEFAULT_WHATSAPP_TEMPLATES.LEAVE_NOTICE, {
      title: "Leave notice — Dr. Ahmed",
      date: "2026-07-29",
      description: " — Out sick",
    });
    expect(withDescription).toBe("Leave notice — Dr. Ahmed (2026-07-29) — Out sick");

    const withoutDescription = fillTemplate(DEFAULT_WHATSAPP_TEMPLATES.LEAVE_NOTICE, {
      title: "Leave notice — Dr. Ahmed",
      date: "2026-07-29",
      description: "",
    });
    expect(withoutDescription).toBe("Leave notice — Dr. Ahmed (2026-07-29)");
  });
});

describe("WHATSAPP_TEMPLATE_PLACEHOLDERS", () => {
  it("has a non-empty, unique placeholder list for every event type", () => {
    for (const list of Object.values(WHATSAPP_TEMPLATE_PLACEHOLDERS)) {
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list).size).toBe(list.length);
    }
  });
});
