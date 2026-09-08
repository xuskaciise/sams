import { describe, it, expect } from "vitest";
import { formatTime12h, formatTimeRange12h } from "./time-format";

describe("formatTime12h", () => {
  it("converts afternoon 24h times to 12h with PM", () => {
    expect(formatTime12h("13:00")).toBe("1:00 PM");
    expect(formatTime12h("14:30")).toBe("2:30 PM");
    expect(formatTime12h("23:59")).toBe("11:59 PM");
  });

  it("converts morning 24h times to 12h with AM", () => {
    expect(formatTime12h("09:05")).toBe("9:05 AM");
    expect(formatTime12h("11:00")).toBe("11:00 AM");
  });

  it("handles the midnight / noon boundaries", () => {
    expect(formatTime12h("00:00")).toBe("12:00 AM");
    expect(formatTime12h("00:30")).toBe("12:30 AM");
    expect(formatTime12h("12:00")).toBe("12:00 PM");
    expect(formatTime12h("12:45")).toBe("12:45 PM");
  });

  it("returns non-HH:MM input unchanged (blank / partial / garbage)", () => {
    expect(formatTime12h("")).toBe("");
    expect(formatTime12h(null)).toBe("");
    expect(formatTime12h(undefined)).toBe("");
    expect(formatTime12h("9")).toBe("9");
    expect(formatTime12h("25:00")).toBe("25:00");
    expect(formatTime12h("10:99")).toBe("10:99");
    expect(formatTime12h("nope")).toBe("nope");
  });
});

describe("formatTimeRange12h", () => {
  it("joins two 12h times with a spaced en dash", () => {
    expect(formatTimeRange12h("13:00", "14:30")).toBe("1:00 PM – 2:30 PM");
    expect(formatTimeRange12h("08:00", "12:00")).toBe("8:00 AM – 12:00 PM");
  });
});
