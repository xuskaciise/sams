-- Semester gains an explicit semester_number (1 or 2) so the Add/Edit
-- Semester form can be a fixed "Semester 1"/"Semester 2" dropdown instead
-- of free text, and so it links cleanly to the batch/plan logic that
-- already keys off semester numbers (Class.current_semester_number,
-- ClassCoursePlan.semester_number — a DIFFERENT 1..8 numbering scheme;
-- this one is just 1 or 2, one per academic year).
ALTER TABLE "semesters" ADD COLUMN "semester_number" INTEGER;

-- Backfill only exact, unambiguous name matches. Anything else (typos,
-- different phrasing, already-migrated custom names) is left NULL for an
-- admin to set explicitly via Edit — never guessed.
UPDATE "semesters" SET "semester_number" = 1 WHERE lower(trim("name")) = 'semester 1';
UPDATE "semesters" SET "semester_number" = 2 WHERE lower(trim("name")) = 'semester 2';

-- Two rows in the same academic year can only end up with the same
-- semester_number here if they had the exact same name once lower-cased
-- and trimmed — the existing semesters_academic_year_id_name_key unique
-- constraint is case-sensitive and whitespace-sensitive, so e.g.
-- "Semester 1" and "semester 1 " could both exist today without
-- violating it, yet both backfill to semester_number = 1. Guard instead
-- of assuming: abort with the exact conflicting rows so an admin can
-- rename/merge one first, never silently drop data by picking a winner.
DO $$
DECLARE
  conflict_summary TEXT;
BEGIN
  SELECT string_agg(
    format('academic_year=%s semester_number=%s (semester_ids: %s)', academic_year_id, semester_number, ids),
    E'\n'
  )
  INTO conflict_summary
  FROM (
    SELECT academic_year_id, semester_number, string_agg(id::text, ', ') AS ids
    FROM "semesters"
    WHERE semester_number IS NOT NULL
    GROUP BY academic_year_id, semester_number
    HAVING COUNT(*) > 1
  ) conflicts;

  IF conflict_summary IS NOT NULL THEN
    RAISE EXCEPTION E'Cannot add the (academic_year_id, semester_number) unique constraint: multiple semesters backfilled to the same number in the same academic year. Rename or delete one of each before re-running this migration:\n%', conflict_summary;
  END IF;
END $$;

CREATE UNIQUE INDEX "semesters_academic_year_id_semester_number_key" ON "semesters"("academic_year_id", "semester_number");
