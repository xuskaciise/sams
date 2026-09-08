import { describe, it, expect } from "vitest";
import { buildNowGrids, rowIdForSession, type NowGridInputSlot, type NowGridShift } from "./now-grid";

function slot(over: Partial<NowGridInputSlot> & { studyMode?: "FT" | "PT" | null; period?: "MORNING" | "AFTERNOON" | null } = {}): NowGridInputSlot {
  const { studyMode = "FT", period = "MORNING", ...rest } = over;
  return {
    id: "s1",
    dayOfWeek: "MON",
    startTime: "09:00",
    endTime: "11:00",
    crossPeriodOverride: false,
    assignment: {
      course: { name: "Algorithms" },
      lecturer: { fullName: "Dr. Ahmed" },
      class: { id: "c-a", name: "CMS26-A-FT", currentSemesterNumber: 5, studyMode, period },
    },
    room: { name: "Room 1", campus: { name: "Main Campus" } },
    ...rest,
  };
}

const shift = (id: string, name: string, startTime: string, endTime: string, studyMode: "FT" | "PT", period: "MORNING" | "AFTERNOON" | null): NowGridShift => ({
  id,
  name,
  studyMode,
  period,
  startTime,
  endTime,
});

const FT_AM_1 = shift("am1", "Subax 1", "08:00", "10:00", "FT", "MORNING");
const FT_AM_2 = shift("am2", "Subax 2", "10:00", "12:00", "FT", "MORNING");
const FT_PM_1 = shift("pm1", "Galab 1", "13:00", "15:00", "FT", "AFTERNOON");
const PT_1 = shift("pt1", "PT Evening", "17:00", "20:00", "PT", null);
const ALL_SHIFTS = [FT_AM_2, FT_AM_1, FT_PM_1, PT_1]; // deliberately unsorted

describe("buildNowGrids — structure groups", () => {
  it("splits sessions by class (studyMode, period) into ordered groups", () => {
    const groups = buildNowGrids(
      [
        slot({ id: "a", studyMode: "FT", period: "MORNING" }),
        slot({ id: "b", studyMode: "FT", period: "AFTERNOON" }),
        slot({ id: "c", studyMode: "FT", period: null }),
        slot({ id: "d", studyMode: "PT", period: null, dayOfWeek: "THU" }),
        slot({ id: "e", studyMode: null, period: null }),
      ],
      ALL_SHIFTS,
      null
    );
    expect(groups.map((g) => g.key)).toEqual(["FT:MORNING", "FT:AFTERNOON", "FT:NONE", "PT", "UNSPEC"]);
    expect(groups.map((g) => g.label)).toEqual([
      "Full-time — Morning",
      "Full-time — Afternoon",
      "Full-time",
      "Part-time",
      "Unspecified study mode",
    ]);
  });

  it("combines several classes that share a structure into ONE grid, each session keeping its class label", () => {
    const groups = buildNowGrids(
      [
        slot({ id: "a", assignment: { course: { name: "Algorithms" }, lecturer: { fullName: "X" }, class: { id: "c-a", name: "CMS26-A-FT", currentSemesterNumber: 5, studyMode: "FT", period: "MORNING" } } }),
        slot({ id: "b", assignment: { course: { name: "Databases" }, lecturer: { fullName: "Y" }, class: { id: "c-b", name: "CMS26-B-FT", currentSemesterNumber: 5, studyMode: "FT", period: "MORNING" } } }),
      ],
      ALL_SHIFTS,
      null
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions.map((s) => s.className).sort()).toEqual([
      "CMS26-A-FT (Semester 5)",
      "CMS26-B-FT (Semester 5)",
    ]);
  });

  it("uses the group's own shift templates as rows, sorted by start time", () => {
    const [g] = buildNowGrids([slot({ studyMode: "FT", period: "MORNING" })], ALL_SHIFTS, null);
    expect(g.rows.map((r) => r.id)).toEqual(["am1", "am2"]); // only FT+MORNING shifts, sorted
  });

  it("synthesizes rows from the sessions' own time ranges when the group has no matching shift", () => {
    const [g] = buildNowGrids(
      [
        slot({ id: "a", startTime: "09:00", endTime: "11:00" }),
        slot({ id: "b", startTime: "13:00", endTime: "14:30" }),
      ],
      [PT_1], // no FT+MORNING shift at all
      null
    );
    expect(g.rows.map((r) => `${r.startTime}-${r.endTime}`)).toEqual(["09:00-11:00", "13:00-14:30"]);
  });

  it("days: a single explicit day yields one column; null yields the whole valid week", () => {
    expect(buildNowGrids([slot({ studyMode: "FT" })], ALL_SHIFTS, "TUE")[0].days).toEqual(["TUE"]);
    expect(buildNowGrids([slot({ studyMode: "FT" })], ALL_SHIFTS, null)[0].days).toEqual([
      "SAT", "SUN", "MON", "TUE", "WED",
    ]);
    expect(buildNowGrids([slot({ studyMode: "PT", dayOfWeek: "THU" })], ALL_SHIFTS, null)[0].days).toEqual([
      "THU", "FRI",
    ]);
    expect(buildNowGrids([slot({ studyMode: null })], ALL_SHIFTS, null)[0].days).toEqual([
      "SAT", "SUN", "MON", "TUE", "WED", "THU", "FRI",
    ]);
  });

  it("maps room label + class label onto each session", () => {
    const [g] = buildNowGrids([slot({ id: "a" })], ALL_SHIFTS, null);
    expect(g.sessions[0]).toMatchObject({
      id: "a",
      courseName: "Algorithms",
      lecturerName: "Dr. Ahmed",
      className: "CMS26-A-FT (Semester 5)",
      roomLabel: "Room 1 — Main Campus",
    });
  });
});

describe("buildNowGrids — cross-period session lands in a row at its ACTUAL time (regression)", () => {
  // An Afternoon class with a cross-period-override session at 11:00
  // (a Morning-shift time). Its own group's rows are Afternoon shifts
  // only — without the fix, the 11:00 session was dropped into the
  // numerically closest Afternoon row (13:00). See the screenshot bug.
  function xSlot(over: Partial<NowGridInputSlot> = {}): NowGridInputSlot {
    return slot({
      studyMode: "FT",
      period: "AFTERNOON",
      startTime: "11:00",
      endTime: "12:30",
      crossPeriodOverride: true,
      ...over,
    });
  }

  it("adds a row from the containing (other-period) shift window and places the session there", () => {
    const [g] = buildNowGrids([xSlot({ id: "x" })], ALL_SHIFTS, null);
    // Afternoon own-row (pm1) + the Morning shift (am2, 10:00–12:00) that
    // actually contains 11:00, sorted by start time.
    expect(g.rows.map((r) => r.id)).toEqual(["am2", "pm1"]);
    const added = g.rows.find((r) => r.id === "am2")!;
    expect(added.crossPeriod).toBe(true);
    // The session resolves to the 11:00 row, NOT the 13:00 Afternoon row.
    expect(rowIdForSession({ startTime: "11:00" }, g.rows)).toBe("am2");
  });

  it("synthesizes a cross-period row when no shift window contains the time", () => {
    const [g] = buildNowGrids(
      [xSlot({ id: "x", startTime: "12:15", endTime: "12:45" })],
      [FT_PM_1], // only an Afternoon shift exists
      null
    );
    expect(g.rows.map((r) => `${r.startTime}-${r.endTime}`)).toEqual(["12:15-12:45", "13:00-15:00"]);
    expect(g.rows.find((r) => r.startTime === "12:15")!.crossPeriod).toBe(true);
    expect(rowIdForSession({ startTime: "12:15" }, g.rows)).toBe(g.rows[0].id);
  });

  it("a cross-period session that DOES fall inside an own-period row needs no extra row", () => {
    const [g] = buildNowGrids(
      [xSlot({ id: "x", startTime: "13:30", endTime: "14:30" })],
      ALL_SHIFTS,
      null
    );
    expect(g.rows.map((r) => r.id)).toEqual(["pm1"]);
    expect(rowIdForSession({ startTime: "13:30" }, g.rows)).toBe("pm1");
  });

  it("a NON-cross-period session outside every own-period row is NOT given an extra row (closest-row fallback, unchanged)", () => {
    const [g] = buildNowGrids(
      [xSlot({ id: "x", startTime: "11:00", endTime: "12:30", crossPeriodOverride: false })],
      ALL_SHIFTS,
      null
    );
    expect(g.rows.map((r) => r.id)).toEqual(["pm1"]); // only the own-period Afternoon shift
  });
});

describe("buildNowGrids — group by class", () => {
  type ClassInfo = NowGridInputSlot["assignment"]["class"];
  const clsA: ClassInfo = { id: "c-a", name: "CMS26-A-FT", currentSemesterNumber: 5, studyMode: "FT", period: "MORNING" };
  const clsB: ClassInfo = { id: "c-b", name: "CMS26-B-FT", currentSemesterNumber: 5, studyMode: "FT", period: "MORNING" };
  const clsPt: ClassInfo = { id: "c-pt", name: "CMS26-C-PT", currentSemesterNumber: 5, studyMode: "PT", period: null };

  function classSlot(id: string, cls: ClassInfo, over: Partial<NowGridInputSlot> = {}): NowGridInputSlot {
    return slot({
      id,
      assignment: { course: { name: `Course ${id}` }, lecturer: { fullName: `Lec ${id}` }, class: cls },
      ...over,
    });
  }

  it("puts each class in its own section (not combined by structure)", () => {
    const groups = buildNowGrids(
      [classSlot("a1", clsA), classSlot("a2", clsA), classSlot("b1", clsB)],
      ALL_SHIFTS,
      null,
      "class"
    );
    expect(groups.map((g) => g.key)).toEqual(["class:c-a", "class:c-b"]);
    expect(groups.map((g) => g.label)).toEqual([
      "CMS26-A-FT (Semester 5)",
      "CMS26-B-FT (Semester 5)",
    ]);
  });

  it("each section holds only that class's sessions", () => {
    const groups = buildNowGrids(
      [classSlot("a1", clsA), classSlot("b1", clsB), classSlot("b2", clsB)],
      ALL_SHIFTS,
      null,
      "class"
    );
    expect(groups.find((g) => g.key === "class:c-a")!.sessions.map((s) => s.id)).toEqual(["a1"]);
    expect(groups.find((g) => g.key === "class:c-b")!.sessions.map((s) => s.id).sort()).toEqual(["b1", "b2"]);
  });

  it("rows/days still respect each class's own studyMode/period", () => {
    const groups = buildNowGrids(
      [classSlot("a1", clsA), classSlot("p1", clsPt, { dayOfWeek: "THU" })],
      ALL_SHIFTS,
      null,
      "class"
    );
    const ft = groups.find((g) => g.key === "class:c-a")!;
    const pt = groups.find((g) => g.key === "class:c-pt")!;
    expect(ft.rows.map((r) => r.id)).toEqual(["am1", "am2"]); // FT+MORNING shifts only
    expect(ft.days).toEqual(["SAT", "SUN", "MON", "TUE", "WED"]);
    expect(pt.rows.map((r) => r.id)).toEqual(["pt1"]);
    expect(pt.days).toEqual(["THU", "FRI"]);
  });

  it("orders sections by structure group then class label; a class with no sessions yields no section", () => {
    const groups = buildNowGrids(
      [classSlot("p1", clsPt, { dayOfWeek: "THU" }), classSlot("b1", clsB), classSlot("a1", clsA)],
      ALL_SHIFTS,
      null,
      "class"
    );
    // FT (order 0) classes before PT (order 3); within FT, by label.
    expect(groups.map((g) => g.key)).toEqual(["class:c-a", "class:c-b", "class:c-pt"]);
  });

  it("default grouping ('structure') is unchanged — several classes share one grid", () => {
    const groups = buildNowGrids([classSlot("a1", clsA), classSlot("b1", clsB)], ALL_SHIFTS, null);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("FT:MORNING");
  });
});

describe("rowIdForSession", () => {
  const rows = [
    { id: "am1", name: "Subax 1", startTime: "08:00", endTime: "10:00" },
    { id: "am2", name: "Subax 2", startTime: "10:00", endTime: "12:00" },
  ];

  it("returns the row whose [start,end) window contains the session start", () => {
    expect(rowIdForSession({ startTime: "09:00" }, rows)).toBe("am1");
    expect(rowIdForSession({ startTime: "10:00" }, rows)).toBe("am2"); // half-open
  });

  it("falls back to the closest row when the time is outside every window", () => {
    expect(rowIdForSession({ startTime: "07:00" }, rows)).toBe("am1");
    expect(rowIdForSession({ startTime: "13:00" }, rows)).toBe("am2");
  });

  it("returns null when there are no rows", () => {
    expect(rowIdForSession({ startTime: "09:00" }, [])).toBeNull();
  });
});
