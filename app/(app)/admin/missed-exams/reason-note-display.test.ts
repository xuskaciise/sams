import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLIENT_FILE = fileURLToPath(new URL("./missed-exams-client.tsx", import.meta.url));

// Regression test for a real bug: a Reason Note typed on Form 2's grid
// was correctly validated, saved, and returned by the DB query (Prisma's
// `include` returns every scalar column by default, so `reasonNote` was
// never actually missing from the data — see admin/missed-exams/
// actions.test.ts's persistence coverage), but the "Recorded missed
// exams" table's JSX simply never rendered it anywhere — only the
// reason TYPE badge (Illness/Cheating/Emergency/Other) was shown. This
// was a pure DISPLAY bug, not a save bug.
//
// This codebase has no component-rendering test infrastructure at all
// (vitest.config.ts runs entirely in Node, no jsdom/React Testing
// Library, and there are zero *.test.tsx files anywhere in the repo —
// consistent with every prior UI-only change in CLAUDE.md's changelog).
// Rather than bolt on a new testing paradigm for one line of JSX, this
// is a lightweight source-presence guard: it reads the client file and
// asserts the "Recorded missed exams" table body actually references
// `r.reasonNote`, so a future refactor that silently drops that
// rendering again fails this test immediately.
describe("MissedExamsClient — records table renders reasonNote", () => {
  it("the records table's Reason cell references r.reasonNote, not just the reason-type badge", () => {
    const source = readFileSync(CLIENT_FILE, "utf-8");

    // Isolate the records.map(...) table body specifically, so this
    // can't accidentally pass by matching one of the OTHER reasonNote
    // references in this same file (the bulk grid's input, the Edit
    // dialog's input, etc.) — those already worked; only this table
    // didn't.
    const tableBodyStart = source.indexOf("{records.map((r, i) =>");
    expect(tableBodyStart).toBeGreaterThan(-1);
    const tableBodyEnd = source.indexOf("{records.length === 0 && (", tableBodyStart);
    expect(tableBodyEnd).toBeGreaterThan(tableBodyStart);

    const tableBody = source.slice(tableBodyStart, tableBodyEnd);
    expect(tableBody).toContain("r.reasonNote");
  });
});
