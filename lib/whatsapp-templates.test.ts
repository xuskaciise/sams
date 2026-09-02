import { describe, it, expect } from "vitest";
import {
  AUTOMATIC_EVENTS,
  AUTOMATIC_EVENT_KEYS,
  MANUAL_TEMPLATE_PLACEHOLDERS,
  placeholdersFor,
  slugifyEventKey,
  findUnknownPlaceholders,
  fillTemplate,
} from "./whatsapp-templates";

describe("findUnknownPlaceholders (AUTOMATIC)", () => {
  it("returns an empty array when every placeholder is known for that event key", () => {
    expect(
      findUnknownPlaceholders("AUTOMATIC", "RESULTS_PUBLISHED", "Hello {studentName}, you scored {mark}")
    ).toEqual([]);
  });

  it("flags a typo'd placeholder (e.g. {studnetName})", () => {
    expect(findUnknownPlaceholders("AUTOMATIC", "RESULTS_PUBLISHED", "Hello {studnetName}")).toEqual([
      "studnetName",
    ]);
  });

  it("flags a placeholder that's valid for a DIFFERENT event key but not this one", () => {
    // {changeSummary} only exists for TIMETABLE_CHANGE.
    expect(findUnknownPlaceholders("AUTOMATIC", "RESULTS_PUBLISHED", "{changeSummary}")).toEqual([
      "changeSummary",
    ]);
  });

  it("de-duplicates repeated unknown placeholders", () => {
    expect(findUnknownPlaceholders("AUTOMATIC", "RESULTS_PUBLISHED", "{oops} and {oops} again")).toEqual([
      "oops",
    ]);
  });

  it("flags everything for an unregistered eventKey — an unregistered key has no known placeholders", () => {
    expect(findUnknownPlaceholders("AUTOMATIC", "NOT_A_REAL_HOOK", "{anything}")).toEqual([
      "anything",
    ]);
  });

  it("every seeded default template uses only known placeholders for its own event key", () => {
    for (const [key, def] of Object.entries(AUTOMATIC_EVENTS)) {
      expect(findUnknownPlaceholders("AUTOMATIC", key, def.defaultTemplateText)).toEqual([]);
    }
  });
});

describe("findUnknownPlaceholders (MANUAL)", () => {
  it("accepts every shared manual placeholder regardless of eventKey", () => {
    expect(
      findUnknownPlaceholders(
        "MANUAL",
        "UNIVERSITY_HOLIDAY",
        "Hi {recipientName}, from {senderName}: {message} ({date}, {className}, {facultyName})"
      )
    ).toEqual([]);
  });

  it("flags a placeholder that's only valid for an AUTOMATIC event", () => {
    expect(findUnknownPlaceholders("MANUAL", "UNIVERSITY_HOLIDAY", "{assessmentTitle}")).toEqual([
      "assessmentTitle",
    ]);
  });

  it("MANUAL placeholder validity never depends on eventKey", () => {
    const text = "{recipientName} {message}";
    expect(findUnknownPlaceholders("MANUAL", "ANY_KEY_AT_ALL", text)).toEqual([]);
    expect(findUnknownPlaceholders("MANUAL", "SOME_OTHER_KEY", text)).toEqual([]);
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
    const template = AUTOMATIC_EVENTS.LEAVE_NOTICE.defaultTemplateText;

    const withDescription = fillTemplate(template, {
      title: "Leave notice — Dr. Ahmed",
      date: "2026-07-29",
      description: " — Out sick",
    });
    expect(withDescription).toBe("Leave notice — Dr. Ahmed (2026-07-29) — Out sick");

    const withoutDescription = fillTemplate(template, {
      title: "Leave notice — Dr. Ahmed",
      date: "2026-07-29",
      description: "",
    });
    expect(withoutDescription).toBe("Leave notice — Dr. Ahmed (2026-07-29)");
  });
});

describe("AUTOMATIC_EVENTS / AUTOMATIC_EVENT_KEYS", () => {
  it("has a non-empty, unique placeholder list for every registered event", () => {
    for (const def of Object.values(AUTOMATIC_EVENTS)) {
      expect(def.placeholders.length).toBeGreaterThan(0);
      expect(new Set(def.placeholders).size).toBe(def.placeholders.length);
    }
  });

  it("contains the 3 original built-in hooks plus the lecturer-credentials and timetable-ready events", () => {
    expect([...AUTOMATIC_EVENT_KEYS].sort()).toEqual([
      "LEAVE_NOTICE",
      "LECTURER_LOGIN_CREDENTIALS",
      "RESULTS_PUBLISHED",
      "TIMETABLE_CHANGE",
      "TIMETABLE_READY",
    ]);
  });

  it("LECTURER_LOGIN_CREDENTIALS carries the credential-specific placeholders", () => {
    expect(new Set(AUTOMATIC_EVENTS.LECTURER_LOGIN_CREDENTIALS.placeholders)).toEqual(
      new Set([
        "academicYear",
        "semesterName",
        "domainName",
        "username",
        "tempPassword",
        "facultyName",
      ])
    );
  });

  it("TIMETABLE_READY carries NO username/password placeholders — it is independent of the credentials event", () => {
    const set = new Set(AUTOMATIC_EVENTS.TIMETABLE_READY.placeholders);
    expect(set).toEqual(new Set(["semesterName", "academicYear", "domainName", "facultyName"]));
    expect(set.has("username")).toBe(false);
    expect(set.has("tempPassword")).toBe(false);
  });
});

describe("placeholdersFor", () => {
  it("returns the registry's placeholder list for AUTOMATIC", () => {
    expect(placeholdersFor("AUTOMATIC", "RESULTS_PUBLISHED")).toEqual(
      AUTOMATIC_EVENTS.RESULTS_PUBLISHED.placeholders
    );
  });

  it("returns an empty list for an unregistered AUTOMATIC key", () => {
    expect(placeholdersFor("AUTOMATIC", "NOT_A_REAL_HOOK")).toEqual([]);
  });

  it("returns the shared MANUAL list regardless of eventKey", () => {
    expect(placeholdersFor("MANUAL", "ANYTHING")).toEqual(MANUAL_TEMPLATE_PLACEHOLDERS);
    expect(placeholdersFor("MANUAL", "SOMETHING_ELSE")).toEqual(MANUAL_TEMPLATE_PLACEHOLDERS);
  });
});

describe("slugifyEventKey", () => {
  it("uppercases and joins words with underscores", () => {
    expect(slugifyEventKey("University Holiday")).toBe("UNIVERSITY_HOLIDAY");
  });

  it("collapses punctuation/whitespace runs into a single underscore", () => {
    expect(slugifyEventKey("  Fee   Reminder!! ")).toBe("FEE_REMINDER");
  });

  it("trims leading/trailing underscores left over from stripped punctuation", () => {
    expect(slugifyEventKey("--Exam Postponed--")).toBe("EXAM_POSTPONED");
  });

  it("returns an empty string for a name with no letters or digits", () => {
    expect(slugifyEventKey("!!!")).toBe("");
  });
});
