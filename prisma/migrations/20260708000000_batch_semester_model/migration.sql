-- Batch/cohort class model: a class row is BATCH + SECTION + MODE
-- (e.g. "CMS2518-A-FT"). Students never move between class rows for
-- normal progression — only current_semester_number advances, via the
-- "Open semester" wizard.

-- CreateEnum
CREATE TYPE "StudyMode" AS ENUM ('FT', 'PT');

-- AlterTable: new nullable batch fields on classes. Nullable so existing
-- rows can be migrated with unparseable data left blank (admin fills in
-- manually afterward) instead of blocking the migration.
ALTER TABLE "classes"
  ADD COLUMN "batch_code" TEXT,
  ADD COLUMN "section" TEXT,
  ADD COLUMN "study_mode" "StudyMode",
  ADD COLUMN "current_semester_number" INTEGER;

-- AlterTable: class_course_plans gains semester_number — a plan row is now
-- (class, semesterNumber, course). Existing rows default to 1; a follow-up
-- data backfill refines this from each class's parsed current_semester_number
-- where possible, then the DEFAULT is dropped since new rows must always
-- specify it explicitly.
ALTER TABLE "class_course_plans" ADD COLUMN "semester_number" INTEGER NOT NULL DEFAULT 1;

DROP INDEX "class_course_plans_class_id_course_id_key";

CREATE UNIQUE INDEX "class_course_plans_class_id_semester_number_course_id_key" ON "class_course_plans"("class_id", "semester_number", "course_id");

ALTER TABLE "class_course_plans" ALTER COLUMN "semester_number" DROP DEFAULT;
