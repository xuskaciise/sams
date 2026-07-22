-- Auto-generated batch codes: batchCode is now derived at class creation
-- from the program's code + the batch's intake (cohort-starting) year,
-- instead of being typed freely. This migration only adds the new
-- nullable intake_year column — existing classes' batch_code values are
-- left exactly as they are (no backfill, no overwrite); intake_year stays
-- NULL for them since it was never captured before now.

-- AlterTable
ALTER TABLE "classes" ADD COLUMN "intake_year" INTEGER;
