import { describe, it, expect } from "vitest";
import { getActionErrorMessage, getSchedulingErrorMessage } from "./action-error";
import { ROOM_CONFLICT_PREFIX } from "./timetable-conflicts";

describe("getActionErrorMessage", () => {
  it("maps known codes to friendly text", () => {
    expect(getActionErrorMessage(new Error("FORBIDDEN"), "x")).toBe(
      "You don't have permission to do this."
    );
  });

  it("strips the ROOM_CONFLICT:: prefix", () => {
    expect(
      getActionErrorMessage(new Error(`${ROOM_CONFLICT_PREFIX}Room A101 is booked.`), "x")
    ).toBe("Room A101 is booked.");
  });

  it("returns the fallback for anything unrecognized", () => {
    expect(getActionErrorMessage(new Error("Some conflict sentence."), "generic")).toBe("generic");
    expect(getActionErrorMessage("not even an error", "generic")).toBe("generic");
  });
});

describe("getSchedulingErrorMessage", () => {
  it("shows a real conflict sentence verbatim instead of the generic fallback (the cross-period Builder bug)", () => {
    const msg = "Physics (CMS26-CMS-4A-FT) — Dr. Ahmed already teaches on SAT 07:45-09:15.";
    expect(getSchedulingErrorMessage(new Error(msg), "Could not schedule this session.")).toBe(msg);
  });

  it("shows an invalid-day sentence verbatim", () => {
    const msg = "Thursday is not a valid teaching day for this class's study mode.";
    expect(getSchedulingErrorMessage(new Error(msg), "Could not schedule this session.")).toBe(msg);
  });

  it("strips the ROOM_CONFLICT:: prefix from a surfaced room clash", () => {
    expect(
      getSchedulingErrorMessage(
        new Error(`${ROOM_CONFLICT_PREFIX}Room B12 is already booked for DB Systems (CMS-A) on MON 09:00-10:00.`),
        "Could not schedule this session."
      )
    ).toBe("Room B12 is already booked for DB Systems (CMS-A) on MON 09:00-10:00.");
  });

  it("still maps a known code to its friendly text", () => {
    expect(getSchedulingErrorMessage(new Error("FORBIDDEN"), "Could not schedule this session.")).toBe(
      "You don't have permission to do this."
    );
  });

  it("keeps the generic fallback for an opaque internal code (no spaces, SCREAMING_SNAKE_CASE)", () => {
    expect(
      getSchedulingErrorMessage(new Error("ASSIGNMENT_NOT_FOUND"), "Could not schedule this session.")
    ).toBe("Could not schedule this session.");
  });

  it("keeps the generic fallback for a non-Error throwable", () => {
    expect(getSchedulingErrorMessage({ weird: true }, "Could not schedule this session.")).toBe(
      "Could not schedule this session."
    );
  });

  it("keeps the generic fallback for an empty message", () => {
    expect(getSchedulingErrorMessage(new Error("   "), "Could not schedule this session.")).toBe(
      "Could not schedule this session."
    );
  });
});
