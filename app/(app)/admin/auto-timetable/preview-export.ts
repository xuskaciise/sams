// PDF/Excel export for the workload-import multi-class OVERVIEW's preview —
// see CLAUDE.md's "Workload Excel import + auto-timetable generation"
// business rule. Deliberately built ENTIRELY client-side, with no Server
// Action round trip at all: the data being exported is the admin/dean's
// current in-memory preview state (`MultiClassOverview`'s `stateByClass`),
// which may include manual drag/edit adjustments that were never written to
// the DB and won't be until "Build all" — there is nothing for a server
// action to query. Both builders take the exact same plain
// `PreviewExportData` shape (already-resolved rows/days/sessions per class,
// the same data `MultiClassOverview` already computes for on-screen
// rendering) so the export can never disagree with what's currently shown
// in the overview.

import type { DayOfWeek } from "@prisma/client";
import { DAY_LABELS } from "@/lib/timetable-days";
import { timeToMinutes } from "@/lib/timetable-conflicts";
import { assignCourseColors, type CourseColorEntry } from "@/lib/course-colors";
import { downloadBlob } from "@/lib/download";

export interface ExportSessionCell {
  id: string;
  courseName: string;
  lecturerName: string;
  roomLabel: string;
  dayOfWeek: DayOfWeek;
  startTime: string;
  endTime: string;
  flagged?: boolean;
  crossPeriodOverride?: boolean;
}

export interface ExportGridRow {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
}

export interface ExportClassGrid {
  classId: string;
  className: string;
  rows: ExportGridRow[];
  days: DayOfWeek[];
  sessions: ExportSessionCell[];
}

export interface PreviewExportData {
  semesterLabel: string;
  level: number;
  classes: ExportClassGrid[];
}

// Same "which row does this session's time fall into" heuristic
// components/timetable/schedule-grid.tsx's ScheduleGrid already uses for
// on-screen rendering (there's no FK from a session to a row/Shift — see
// CLAUDE.md's Shifts section) — duplicated here as a small, standalone pure
// function rather than importing from that "use client" component file, so
// this module stays a plain, independently testable data-shaping module.
function rowForSession(session: Pick<ExportSessionCell, "startTime">, rows: ExportGridRow[]): ExportGridRow | null {
  if (rows.length === 0) return null;
  const t = timeToMinutes(session.startTime);
  const contained = rows.find((r) => t >= timeToMinutes(r.startTime) && t < timeToMinutes(r.endTime));
  if (contained) return contained;
  return [...rows].sort((a, b) => Math.abs(timeToMinutes(a.startTime) - t) - Math.abs(timeToMinutes(b.startTime) - t))[0];
}

export function sessionsForCell(cls: ExportClassGrid, rowId: string, day: DayOfWeek): ExportSessionCell[] {
  return cls.sessions.filter((s) => s.dayOfWeek === day && rowForSession(s, cls.rows)?.id === rowId);
}

// Every course name across the WHOLE export (all classes in this batch) —
// colors are assigned once per export from this full set, so the same
// course gets the same color everywhere it appears, even across classes.
export function buildCourseColorMap(data: PreviewExportData): Map<string, CourseColorEntry> {
  const names = data.classes.flatMap((c) => c.sessions.map((s) => s.courseName));
  return assignCourseColors(names);
}

export function sortedLegendEntries(colors: Map<string, CourseColorEntry>): CourseColorEntry[] {
  return [...colors.values()].sort((a, b) => a.label.localeCompare(b.label));
}

// One line of cell text per session — course + lecturer, with a plain-text
// marker for the two flags this app already tracks per session (spacing
// fallback / cross-period override) so they stay visible in an exported,
// static document that can't show a hover tooltip or a colored badge the
// way the on-screen ScheduleGrid does.
export function cellText(session: ExportSessionCell): string {
  const markers = [session.flagged ? "⚠ fallback" : null, session.crossPeriodOverride ? "⤨ cross-period" : null].filter(
    (m): m is string => m !== null
  );
  return `${session.courseName} — ${session.lecturerName}${markers.length > 0 ? ` (${markers.join(", ")})` : ""}`;
}

export function rowLabel(row: ExportGridRow): string {
  return `${row.name}\n${row.startTime}–${row.endTime}`;
}

export function dayHeaders(days: DayOfWeek[]): string[] {
  return days.map((d) => DAY_LABELS[d]);
}

function sanitizeFileNamePart(label: string): string {
  return label.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
}

export function previewExportFileName(data: PreviewExportData, extension: "xlsx" | "pdf"): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `Timetable_Preview_${sanitizeFileNamePart(data.semesterLabel)}_Level${data.level}_${stamp}.${extension}`;
}

function hexToRgbTuple(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)];
}

function argbFromHex(hex: string): string {
  return `FF${hex.replace("#", "").toUpperCase()}`;
}

// Excel sheet names are capped at 31 chars and can't repeat (case-
// insensitive) or contain \/?*[]: — a class name can collide with another
// after truncation, so this dedupes with a numbered suffix rather than
// letting exceljs throw on a duplicate/invalid name.
function sanitizeSheetName(name: string, used: Set<string>): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, " ").trim() || "Class";
  let candidate = cleaned.slice(0, 31);
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${i})`;
    candidate = `${cleaned.slice(0, 31 - suffix.length)}${suffix}`;
    i++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

// ============================================================
// Excel — via exceljs (the existing `xlsx` dependency elsewhere in this
// app is write-side style-limited in its free/community form — no cell
// fill-color support — so this ONE color-coded export uses exceljs
// instead; every other xlsx export in this app is untouched and has no
// need to migrate, since none of them color cells).
// ============================================================

export async function buildPreviewWorkbook(data: PreviewExportData) {
  const { Workbook } = await import("exceljs");
  const colors = buildCourseColorMap(data);
  const workbook = new Workbook();
  workbook.creator = "SAMS";
  workbook.created = new Date();

  const legendSheet = workbook.addWorksheet("Legend");
  legendSheet.columns = [
    { header: "Color", key: "color", width: 10 },
    { header: "Course", key: "course", width: 42 },
  ];
  legendSheet.getRow(1).font = { bold: true };
  for (const entry of sortedLegendEntries(colors)) {
    const row = legendSheet.addRow({ color: "", course: entry.label });
    row.getCell("color").fill = { type: "pattern", pattern: "solid", fgColor: { argb: argbFromHex(entry.hex) } };
  }

  const usedSheetNames = new Set<string>(["legend"]);
  for (const cls of data.classes) {
    const sheet = workbook.addWorksheet(sanitizeSheetName(cls.className, usedSheetNames));
    sheet.getColumn(1).width = 22;
    const headerRow = sheet.addRow(["Shift", ...dayHeaders(cls.days)]);
    headerRow.font = { bold: true };
    headerRow.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } };
    });

    for (const row of cls.rows) {
      const rowValues = [rowLabel(row), ...cls.days.map((day) => sessionsForCell(cls, row.id, day).map(cellText).join("\n\n"))];
      const excelRow = sheet.addRow(rowValues);
      excelRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.alignment = { wrapText: true, vertical: "middle" };
      });
      cls.days.forEach((day, i) => {
        const sessions = sessionsForCell(cls, row.id, day);
        if (sessions.length === 0) return;
        const entry = colors.get(sessions[0].courseName);
        if (!entry) return;
        const cell = excelRow.getCell(i + 2);
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argbFromHex(entry.hex) } };
        cell.font = { color: { argb: argbFromHex(entry.textColor) } };
      });
      const maxSessionsInRow = Math.max(1, ...cls.days.map((day) => sessionsForCell(cls, row.id, day).length));
      excelRow.height = Math.max(30, maxSessionsInRow * 24);
    }

    cls.days.forEach((_, i) => {
      sheet.getColumn(i + 2).width = 30;
    });
  }

  return workbook;
}

export async function downloadPreviewExcel(data: PreviewExportData) {
  const workbook = await buildPreviewWorkbook(data);
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    previewExportFileName(data, "xlsx")
  );
}

// ============================================================
// PDF — via jsPDF + jspdf-autotable. One legend page, then one page per
// class (landscape, so a typical FT 5-day-wide grid fits comfortably
// width-wise — width was never actually the bottleneck here, see below).
// ============================================================

// A class's grid used to spill onto a second page mid-grid because
// `autoTable` was given a FIXED `fontSize: 8` / `cellPadding: 4`
// regardless of how many Shift ROWS a class has or how much text (course +
// lecturer, possibly several sessions stacked in one cell) each cell
// wraps to — jspdf-autotable's default behavior when a table's total
// height exceeds what's left on the page is to just keep drawing onto a
// fresh page, with no "shrink to fit one page" of its own. Width was
// essentially never the actual cause: this app's own day-count ceiling
// (`lib/timetable-days.ts`) is 5 (FT) or 2 (PT) real day columns, which —
// already on a landscape A4 page — leaves each day column comfortably
// wide regardless of class type; a wide class doesn't run off the page
// edge, it just has more (fully visible) columns. HEIGHT was the actual
// axis overflowing: a class with more Shift rows, or with cells stacking
// multiple sessions, needs more vertical space, and nothing scaled to
// account for that.
//
// The fix: for EACH class independently (an FT class's own row/column
// count has nothing to do with a PT class's), measure how tall its grid
// would actually render at a few candidate font sizes — using jsPDF's own
// `splitTextToSize` against that class's real column widths, so the
// measurement reflects real wrapped line counts, not a guess — and pick
// the LARGEST candidate that fits within one page's remaining height.
// Never drops below `MIN_READABLE_FONT_SIZE` — a class dense enough that
// even the floor size doesn't fit is left to spill onto a second page
// (jspdf-autotable's own default) rather than shrunk into illegibility,
// and reported back to the caller so the admin is told, not left to
// discover a still-cut-off class on their own.
export const MIN_READABLE_FONT_SIZE = 6;
const CANDIDATE_FONT_SIZES = [10, 9, 8, 7, MIN_READABLE_FONT_SIZE];
const PAGE_MARGIN = 40;
const TABLE_TOP_Y = 70;
const TABLE_BOTTOM_MARGIN = 30;
const SHIFT_COLUMN_WIDTH = 90;
// Estimated vs. actually-rendered height can differ slightly (autoTable's
// own internal padding/rounding isn't identical to this estimate) — a
// small safety margin trades a little conservatism for not silently
// re-overflowing a class that only just barely fit the estimate.
const HEIGHT_SAFETY_MARGIN = 1.08;

function cellPaddingForFontSize(fontSize: number): number {
  return fontSize <= 7 ? 3 : 4;
}

// How tall this ONE class's table would render at `fontSize` — the
// header row (1 line) + one row per Shift, each row's height driven by
// whichever cell in it wraps to the most lines (autoTable rows are
// uniform height = the tallest cell), using the SAME column widths the
// real autoTable call will use.
function estimateTableHeight(
  doc: import("jspdf").jsPDF,
  cls: ExportClassGrid,
  fontSize: number,
  dayColumnWidth: number
): number {
  doc.setFontSize(fontSize);
  const cellPadding = cellPaddingForFontSize(fontSize);
  const lineHeight = fontSize * doc.getLineHeightFactor();
  const rowHeight = (maxLines: number) => cellPadding * 2 + maxLines * lineHeight;

  let total = rowHeight(1); // header row — day names are a single line
  for (const row of cls.rows) {
    let maxLines = 2; // the Shift label cell is always name + time, 2 lines
    for (const day of cls.days) {
      const sessions = sessionsForCell(cls, row.id, day);
      if (sessions.length === 0) continue;
      const text = sessions.map(cellText).join("\n\n");
      const wrapped = doc.splitTextToSize(text, dayColumnWidth - cellPadding * 2) as string[];
      maxLines = Math.max(maxLines, wrapped.length);
    }
    total += rowHeight(maxLines);
  }
  return total * HEIGHT_SAFETY_MARGIN;
}

// Picks the largest candidate font size whose ESTIMATED table height fits
// within `availableHeight`; if none do, returns the smallest candidate
// (the floor) plus `fits: false` so the caller can report the overflow
// rather than pretend it was handled. Exported for direct unit testing —
// this is the actual per-class auto-scaling decision, independent of any
// jsPDF drawing/pagination side effects.
export function pickFontSizeForClass(
  doc: import("jspdf").jsPDF,
  cls: ExportClassGrid,
  dayColumnWidth: number,
  availableHeight: number
): { fontSize: number; cellPadding: number; fits: boolean } {
  let fallback = CANDIDATE_FONT_SIZES[CANDIDATE_FONT_SIZES.length - 1];
  for (const size of CANDIDATE_FONT_SIZES) {
    const estimated = estimateTableHeight(doc, cls, size, dayColumnWidth);
    if (estimated <= availableHeight) {
      return { fontSize: size, cellPadding: cellPaddingForFontSize(size), fits: true };
    }
    fallback = size;
  }
  return { fontSize: fallback, cellPadding: cellPaddingForFontSize(fallback), fits: false };
}

export interface BuildPreviewPdfResult {
  doc: import("jspdf").jsPDF;
  // Classes whose grid didn't fit on one page even at MIN_READABLE_FONT_SIZE
  // — reported, not silently left for the admin to discover a still-
  // cut-off page on their own.
  overflowClassNames: string[];
}

export async function buildPreviewPdf(data: PreviewExportData): Promise<BuildPreviewPdfResult> {
  const { jsPDF } = await import("jspdf");
  const autoTable = (await import("jspdf-autotable")).default;
  const colors = buildCourseColorMap(data);

  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const usableWidth = pageWidth - PAGE_MARGIN * 2;
  const availableHeight = pageHeight - TABLE_TOP_Y - TABLE_BOTTOM_MARGIN;
  const overflowClassNames: string[] = [];

  // Legend page (the document's first page — no extra addPage() needed,
  // jsPDF already starts with one blank page).
  doc.setFontSize(16);
  doc.text(`Timetable Preview — ${data.semesterLabel}`, 40, 44);
  doc.setFontSize(11);
  doc.setTextColor(90);
  doc.text(`Semester level ${data.level} — ${data.classes.length} class${data.classes.length === 1 ? "" : "es"}`, 40, 62);
  doc.setTextColor(0);
  doc.setFontSize(12);
  doc.text("Color legend", 40, 92);

  const entries = sortedLegendEntries(colors);
  const swatchSize = 12;
  const colWidth = 250;
  const rowHeight = 20;
  const colsPerPage = Math.max(1, Math.floor((pageWidth - 80) / colWidth));
  const rowsPerCol = 22;
  doc.setFontSize(9);
  entries.forEach((entry, i) => {
    const col = Math.floor(i / rowsPerCol) % colsPerPage;
    const row = i % rowsPerCol;
    const x = 40 + col * colWidth;
    const y = 110 + row * rowHeight;
    doc.setFillColor(...hexToRgbTuple(entry.hex));
    doc.rect(x, y - swatchSize + 2, swatchSize, swatchSize, "F");
    doc.setTextColor(0);
    doc.text(entry.label, x + swatchSize + 8, y);
  });

  for (const cls of data.classes) {
    doc.addPage();

    // Sized to THIS class's own row/column count — an FT class (more
    // Shift rows, 5 day columns) and a PT class (fewer rows, 2 columns)
    // are measured and scaled completely independently of each other.
    const dayColumnWidth = cls.days.length > 0 ? (usableWidth - SHIFT_COLUMN_WIDTH) / cls.days.length : usableWidth;
    const { fontSize, cellPadding, fits } = pickFontSizeForClass(doc, cls, dayColumnWidth, availableHeight);
    if (!fits) overflowClassNames.push(cls.className);

    doc.setFontSize(14);
    doc.setTextColor(0);
    doc.text(cls.className, PAGE_MARGIN, 40);
    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.text(`${data.semesterLabel} — Semester level ${data.level}`, PAGE_MARGIN, 56);
    doc.setTextColor(0);

    const head = [["Shift", ...dayHeaders(cls.days)]];
    const body = cls.rows.map((row) => {
      const rowCells: (string | { content: string; styles: Record<string, unknown> })[] = [rowLabel(row)];
      for (const day of cls.days) {
        const sessions = sessionsForCell(cls, row.id, day);
        const text = sessions.map(cellText).join("\n\n");
        const entry = sessions[0] ? colors.get(sessions[0].courseName) : undefined;
        rowCells.push(
          entry
            ? { content: text, styles: { fillColor: hexToRgbTuple(entry.hex), textColor: hexToRgbTuple(entry.textColor) } }
            : { content: text, styles: {} }
        );
      }
      return rowCells;
    });

    autoTable(doc, {
      startY: TABLE_TOP_Y,
      margin: { left: PAGE_MARGIN, right: PAGE_MARGIN, bottom: TABLE_BOTTOM_MARGIN },
      head,
      body,
      styles: { fontSize, cellPadding, valign: "middle", lineColor: [200, 200, 200], lineWidth: 0.5 },
      headStyles: { fillColor: [230, 230, 230], textColor: [20, 20, 20], fontStyle: "bold" },
      columnStyles: { 0: { cellWidth: SHIFT_COLUMN_WIDTH, fontStyle: "bold" } },
      theme: "grid",
      // A dense class already sized down to the readable floor still
      // spills onto a further page rather than being forced smaller —
      // this just stops autoTable from splitting a single ROW across
      // that page boundary, so at least every session stays fully intact
      // and readable on whichever page it lands on.
      rowPageBreak: "avoid",
    });
  }

  return { doc, overflowClassNames };
}

export async function downloadPreviewPdf(data: PreviewExportData): Promise<{ overflowClassNames: string[] }> {
  const { doc, overflowClassNames } = await buildPreviewPdf(data);
  doc.save(previewExportFileName(data, "pdf"));
  return { overflowClassNames };
}
