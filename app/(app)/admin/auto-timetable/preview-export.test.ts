import { describe, it, expect } from "vitest";
import { jsPDF } from "jspdf";
import type { DayOfWeek } from "@prisma/client";
import {
  sessionsForCell,
  buildCourseColorMap,
  sortedLegendEntries,
  cellText,
  rowLabel,
  dayHeaders,
  previewExportFileName,
  buildPreviewWorkbook,
  buildPreviewPdf,
  pickFontSizeForClass,
  MIN_READABLE_FONT_SIZE,
  type ExportClassGrid,
  type ExportGridRow,
  type PreviewExportData,
  type ExportSessionCell,
} from "./preview-export";

function session(overrides: Partial<ExportSessionCell> = {}): ExportSessionCell {
  return {
    id: "s1",
    courseName: "Databases",
    lecturerName: "Dr. Ahmed",
    roomLabel: "Room 101 — Main Campus",
    dayOfWeek: "SAT",
    startTime: "08:00",
    endTime: "09:30",
    ...overrides,
  };
}

const shiftRows = [
  { id: "shift-1", name: "Subax 1aad", startTime: "08:00", endTime: "09:30" },
  { id: "shift-2", name: "Subax 2aad", startTime: "10:00", endTime: "11:30" },
];

function classGrid(overrides: Partial<ExportClassGrid> = {}): ExportClassGrid {
  return {
    classId: "class-1",
    className: "CMS26-A-FT",
    rows: shiftRows,
    days: ["SAT", "SUN"],
    sessions: [session()],
    ...overrides,
  };
}

// An FT class's real shape: 5 valid teaching days (lib/timetable-days.ts)
// and, in a busy real timetable, several Shift rows with cells stacking
// more than one session — much denser than the PT-shaped `classGrid()`
// default (2 days, 2 rows, one session) used throughout the rest of this
// file. Long-ish course/lecturer names are used deliberately so the text
// actually wraps to multiple lines at the larger candidate font sizes,
// the same real-world condition that caused the reported cutoff.
const FT_DAYS: DayOfWeek[] = ["SAT", "SUN", "MON", "TUE", "WED"];
const ftShiftRows: ExportGridRow[] = Array.from({ length: 8 }, (_, i) => ({
  id: `ft-shift-${i}`,
  name: `Subax ${i + 1}aad`,
  startTime: `${String(8 + i).padStart(2, "0")}:00`,
  endTime: `${String(9 + i).padStart(2, "0")}:30`,
}));

function denseFtClassGrid(overrides: Partial<ExportClassGrid> = {}): ExportClassGrid {
  const sessions: ExportSessionCell[] = [];
  ftShiftRows.forEach((row, rowIndex) => {
    FT_DAYS.forEach((day) => {
      // Two stacked sessions per cell with longish names, so cellText's
      // joined output genuinely wraps to several lines per cell.
      sessions.push(
        session({
          id: `${row.id}-${day}-a`,
          courseName: `Introduction to Advanced Software Engineering ${rowIndex}`,
          lecturerName: "Prof. Abdirahman Mohamed Warsame",
          dayOfWeek: day,
          startTime: row.startTime,
          endTime: row.endTime,
        }),
        session({
          id: `${row.id}-${day}-b`,
          courseName: `Database Systems and Distributed Computing ${rowIndex}`,
          lecturerName: "Dr. Fadumo Ali Hassan",
          dayOfWeek: day,
          startTime: row.startTime,
          endTime: row.endTime,
        })
      );
    });
  });
  return {
    classId: "class-ft",
    className: "CMS26-A-FT",
    rows: ftShiftRows,
    days: FT_DAYS,
    sessions,
    ...overrides,
  };
}

// Same landscape A4 setup buildPreviewPdf itself constructs — used directly
// by the pickFontSizeForClass tests so the "available height" they measure
// against matches production exactly, without re-exporting the page-layout
// constants purely for test convenience.
function landscapeA4Doc() {
  return new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
}

describe("sessionsForCell", () => {
  it("resolves a session into the row whose time window contains it", () => {
    const cls = classGrid({ sessions: [session({ startTime: "08:00", endTime: "09:30" })] });
    expect(sessionsForCell(cls, "shift-1", "SAT")).toHaveLength(1);
    expect(sessionsForCell(cls, "shift-2", "SAT")).toHaveLength(0);
  });

  it("falls back to the closest row when the time doesn't exactly match any window", () => {
    const cls = classGrid({ sessions: [session({ startTime: "09:45", endTime: "10:15" })] });
    // 09:45 is closer to shift-2 (10:00) than shift-1 (08:00).
    expect(sessionsForCell(cls, "shift-2", "SAT")).toHaveLength(1);
  });

  it("never matches the wrong day", () => {
    const cls = classGrid({ sessions: [session({ dayOfWeek: "SAT" })] });
    expect(sessionsForCell(cls, "shift-1", "SUN")).toHaveLength(0);
  });
});

describe("buildCourseColorMap", () => {
  it("assigns one color per distinct course name across ALL classes in the export", () => {
    const data: PreviewExportData = {
      semesterLabel: "Semester 1 (2026-2027)",
      level: 3,
      classes: [
        classGrid({ classId: "class-1", sessions: [session({ courseName: "Databases" })] }),
        classGrid({ classId: "class-2", sessions: [session({ courseName: "Networks" }), session({ courseName: "Databases" })] }),
      ],
    };
    const colors = buildCourseColorMap(data);
    expect(colors.size).toBe(2);
    expect(colors.has("Databases")).toBe(true);
    expect(colors.has("Networks")).toBe(true);
  });

  it("gives the SAME course the same color across different classes", () => {
    const data: PreviewExportData = {
      semesterLabel: "Semester 1",
      level: 1,
      classes: [
        classGrid({ classId: "class-1", sessions: [session({ courseName: "Databases" })] }),
        classGrid({ classId: "class-2", sessions: [session({ courseName: "Databases" })] }),
      ],
    };
    const colors = buildCourseColorMap(data);
    // One entry, one color, regardless of how many classes/sessions reference it.
    expect(colors.size).toBe(1);
  });
});

describe("sortedLegendEntries", () => {
  it("sorts alphabetically by course name", () => {
    const colors = buildCourseColorMap({
      semesterLabel: "S",
      level: 1,
      classes: [classGrid({ sessions: [session({ courseName: "Zoology" }), session({ courseName: "Algorithms" })] })],
    });
    const entries = sortedLegendEntries(colors);
    expect(entries.map((e) => e.label)).toEqual(["Algorithms", "Zoology"]);
  });
});

describe("cellText", () => {
  it("shows course and lecturer with no markers for a normal session", () => {
    expect(cellText(session())).toBe("Databases — Dr. Ahmed");
  });

  it("flags a spacing-fallback session", () => {
    expect(cellText(session({ flagged: true }))).toBe("Databases — Dr. Ahmed (⚠ fallback)");
  });

  it("flags a cross-period override session", () => {
    expect(cellText(session({ crossPeriodOverride: true }))).toBe("Databases — Dr. Ahmed (⤨ cross-period)");
  });

  it("shows both markers together if somehow both are true", () => {
    expect(cellText(session({ flagged: true, crossPeriodOverride: true }))).toBe(
      "Databases — Dr. Ahmed (⚠ fallback, ⤨ cross-period)"
    );
  });
});

describe("rowLabel / dayHeaders", () => {
  it("formats a shift row as name + time range", () => {
    expect(rowLabel(shiftRows[0])).toBe("Subax 1aad\n08:00–09:30");
  });

  it("maps DayOfWeek values to their display labels", () => {
    expect(dayHeaders(["SAT", "SUN"])).toEqual(["Saturday", "Sunday"]);
  });
});

describe("previewExportFileName", () => {
  it("sanitizes the semester label and includes the level and today's date", () => {
    const name = previewExportFileName({ semesterLabel: "Semester 1 (2026-2027)", level: 3, classes: [] }, "xlsx");
    expect(name).toMatch(/^Timetable_Preview_Semester_1_2026_2027_Level3_\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it("uses the requested extension", () => {
    const name = previewExportFileName({ semesterLabel: "S1", level: 1, classes: [] }, "pdf");
    expect(name.endsWith(".pdf")).toBe(true);
  });
});

// exceljs's first dynamic import() under Vitest is slow to transform/cold-
// start (well over the default 5s test timeout) — the library itself runs
// fine once loaded, this is purely one-time module-load overhead, not a
// real hang.
describe("buildPreviewWorkbook", { timeout: 20000 }, () => {
  it("builds a Legend sheet first, then one sheet per class", async () => {
    const data: PreviewExportData = {
      semesterLabel: "Semester 1",
      level: 3,
      classes: [classGrid({ className: "CMS26-A-FT" }), classGrid({ classId: "class-2", className: "CMS26-B-FT", sessions: [] })],
    };
    const workbook = await buildPreviewWorkbook(data);
    const names = workbook.worksheets.map((s) => s.name);
    expect(names).toEqual(["Legend", "CMS26-A-FT", "CMS26-B-FT"]);
  });

  it("colors a session cell with its course's assigned fill and text color", async () => {
    const data: PreviewExportData = {
      semesterLabel: "Semester 1",
      level: 3,
      classes: [classGrid({ sessions: [session({ courseName: "Databases", dayOfWeek: "SAT", startTime: "08:00", endTime: "09:30" })] })],
    };
    const workbook = await buildPreviewWorkbook(data);
    const sheet = workbook.getWorksheet("CMS26-A-FT")!;
    // Row 1 = header, row 2 = shift-1 (SAT is the first day column -> cell 2).
    const cell = sheet.getRow(2).getCell(2);
    expect(cell.value).toContain("Databases");
    expect((cell.fill as { fgColor: { argb: string } }).fgColor.argb).toBeDefined();
  });

  it("dedupes/sanitizes duplicate or overlong class names into distinct valid sheet names", async () => {
    const longName = "A".repeat(40);
    const data: PreviewExportData = {
      semesterLabel: "Semester 1",
      level: 3,
      classes: [
        classGrid({ classId: "c1", className: longName, sessions: [] }),
        classGrid({ classId: "c2", className: longName, sessions: [] }),
      ],
    };
    const workbook = await buildPreviewWorkbook(data);
    const names = workbook.worksheets.map((s) => s.name).filter((n) => n !== "Legend");
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names[0].length).toBeLessThanOrEqual(31);
    expect(names[1].length).toBeLessThanOrEqual(31);
  });

  it("leaves an open cell (no sessions) with no fill", async () => {
    const data: PreviewExportData = { semesterLabel: "S", level: 1, classes: [classGrid({ sessions: [] })] };
    const workbook = await buildPreviewWorkbook(data);
    const sheet = workbook.getWorksheet("CMS26-A-FT")!;
    const cell = sheet.getRow(2).getCell(2);
    expect(cell.value).toBe("");
    expect(cell.fill).toBeUndefined();
  });
});

// Covers the PDF layout cutoff fix: each class's font/cell size is picked
// independently from its own row/day density so it renders on ONE page,
// per CLAUDE.md's "PDF layout cutoff fix" changelog entry.
describe("pickFontSizeForClass", () => {
  it("picks the largest candidate font size for a light PT-shaped class (2 days, 2 rows, one session each)", () => {
    const doc = landscapeA4Doc();
    const pageWidth = doc.internal.pageSize.getWidth();
    const availableHeight = doc.internal.pageSize.getHeight() - 70 - 30; // TABLE_TOP_Y / TABLE_BOTTOM_MARGIN
    const cls = classGrid(); // the file's existing PT-shaped default: 2 days, 2 rows
    const dayColumnWidth = (pageWidth - 80 - 90) / cls.days.length; // PAGE_MARGIN*2 + SHIFT_COLUMN_WIDTH
    const result = pickFontSizeForClass(doc, cls, dayColumnWidth, availableHeight);
    expect(result.fontSize).toBe(10); // the largest CANDIDATE_FONT_SIZES entry
    expect(result.fits).toBe(true);
  });

  it("picks a SMALLER font size than the light PT class for a dense FT-shaped class (5 days, 8 rows, stacked sessions), while still fitting one page", () => {
    const doc = landscapeA4Doc();
    const pageWidth = doc.internal.pageSize.getWidth();
    const availableHeight = doc.internal.pageSize.getHeight() - 70 - 30;

    const ptClass = classGrid();
    const ptColumnWidth = (pageWidth - 80 - 90) / ptClass.days.length;
    const ptResult = pickFontSizeForClass(doc, ptClass, ptColumnWidth, availableHeight);

    const ftClass = denseFtClassGrid();
    const ftColumnWidth = (pageWidth - 80 - 90) / ftClass.days.length;
    const ftResult = pickFontSizeForClass(doc, ftClass, ftColumnWidth, availableHeight);

    expect(ftResult.fontSize).toBeLessThan(ptResult.fontSize);
    expect(ftResult.fits).toBe(true); // still fits — just at a smaller, still-readable size
    expect(ftResult.fontSize).toBeGreaterThanOrEqual(MIN_READABLE_FONT_SIZE);
  });

  it("falls back to the readable floor and reports fits:false when a class is genuinely too dense for any candidate size", () => {
    const doc = landscapeA4Doc();
    const cls = denseFtClassGrid();
    const dayColumnWidth = 100;
    // A deliberately tiny available height stands in for "even the floor
    // candidate's real estimated height exceeds what's left on the page" —
    // exercising the genuine-overflow branch deterministically, without
    // depending on exact wrapped-line arithmetic for a specific class shape.
    const result = pickFontSizeForClass(doc, cls, dayColumnWidth, 20);
    expect(result.fontSize).toBe(MIN_READABLE_FONT_SIZE);
    expect(result.fits).toBe(false);
  });
});

describe("buildPreviewPdf", { timeout: 20000 }, () => {
  it("renders a light PT-shaped class and a dense FT-shaped class each on exactly one page, with no reported overflow", async () => {
    const data: PreviewExportData = {
      semesterLabel: "Semester 1",
      level: 3,
      classes: [classGrid({ classId: "class-pt", className: "CMS26-A-PT" }), denseFtClassGrid()],
    };
    const { doc, overflowClassNames } = await buildPreviewPdf(data);
    // 1 legend page + 1 page per class, and NOT more — i.e. neither class
    // spilled onto a second page.
    expect(doc.getNumberOfPages()).toBe(1 + data.classes.length);
    expect(overflowClassNames).toEqual([]);
  });

  it("reports (and only reports) a class that genuinely can't fit even at the readable floor, rather than silently leaving it cut off", async () => {
    // Far denser than the "dense FT" fixture above — many more rows, so
    // even MIN_READABLE_FONT_SIZE's estimated height exceeds one page.
    const manyRows: ExportGridRow[] = Array.from({ length: 60 }, (_, i) => ({
      id: `huge-shift-${i}`,
      name: `Shift ${i + 1}`,
      startTime: "08:00",
      endTime: "09:00",
    }));
    const hugeSessions: ExportSessionCell[] = manyRows.flatMap((row) =>
      FT_DAYS.map((day) =>
        session({
          id: `${row.id}-${day}`,
          courseName: `Course ${row.id}`,
          lecturerName: "Some Lecturer",
          dayOfWeek: day,
          startTime: row.startTime,
          endTime: row.endTime,
        })
      )
    );
    const overflowingClass: ExportClassGrid = {
      classId: "class-huge",
      className: "CMS26-Z-FT",
      rows: manyRows,
      days: FT_DAYS,
      sessions: hugeSessions,
    };
    const data: PreviewExportData = {
      semesterLabel: "Semester 1",
      level: 3,
      classes: [classGrid({ classId: "class-pt", className: "CMS26-A-PT" }), overflowingClass],
    };
    const { doc, overflowClassNames } = await buildPreviewPdf(data);
    expect(overflowClassNames).toEqual(["CMS26-Z-FT"]);
    // The well-behaved PT class still didn't spill; only the pathological
    // one did, so total pages is MORE than 1-per-class but the overflow
    // list correctly names exactly which one.
    expect(doc.getNumberOfPages()).toBeGreaterThan(1 + data.classes.length);
  });
});
