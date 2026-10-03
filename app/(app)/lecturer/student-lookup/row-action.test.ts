import { describe, it, expect } from "vitest";
import { resolveLookupRowAction } from "./row-action";

const active = "ACTIVE" as const;

describe("resolveLookupRowAction", () => {
  it("no result + DRAFT assessment -> inline entry (saveResult)", () => {
    expect(
      resolveLookupRowAction({ assessmentStatus: "DRAFT", resultStatus: null, enrollmentStatus: active })
    ).toEqual({ kind: "ENTER" });
  });

  it("no result + PUBLISHED assessment -> late-add flow", () => {
    expect(
      resolveLookupRowAction({ assessmentStatus: "PUBLISHED", resultStatus: null, enrollmentStatus: active })
    ).toEqual({ kind: "LATE_ADD" });
  });

  it("DRAFT result under a DRAFT assessment -> edit, no per-row publish", () => {
    expect(
      resolveLookupRowAction({ assessmentStatus: "DRAFT", resultStatus: "DRAFT", enrollmentStatus: active })
    ).toEqual({ kind: "EDIT_DRAFT", canPublish: false });
  });

  it("late DRAFT result under a PUBLISHED assessment -> edit + publishLateResult", () => {
    expect(
      resolveLookupRowAction({ assessmentStatus: "PUBLISHED", resultStatus: "DRAFT", enrollmentStatus: active })
    ).toEqual({ kind: "EDIT_DRAFT", canPublish: true });
  });

  it("PUBLISHED result -> correction flow, never a direct edit", () => {
    expect(
      resolveLookupRowAction({ assessmentStatus: "PUBLISHED", resultStatus: "PUBLISHED", enrollmentStatus: active })
    ).toEqual({ kind: "CORRECT" });
  });

  it("CLOSED assessment is read-only regardless of result state", () => {
    for (const resultStatus of [null, "DRAFT", "PUBLISHED"] as const) {
      const action = resolveLookupRowAction({
        assessmentStatus: "CLOSED",
        resultStatus,
        enrollmentStatus: active,
      });
      expect(action.kind).toBe("READ_ONLY");
      expect(action.kind === "READ_ONLY" && action.reason).toMatch(/closed/i);
    }
  });

  it("a non-ACTIVE enrollment is read-only (matches the Marks Entry Grid roster)", () => {
    const action = resolveLookupRowAction({
      assessmentStatus: "PUBLISHED",
      resultStatus: null,
      enrollmentStatus: "TRANSFERRED",
    });
    expect(action.kind).toBe("READ_ONLY");
  });
});
