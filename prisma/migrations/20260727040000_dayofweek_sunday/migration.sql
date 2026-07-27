-- Adds Sunday to DayOfWeek — needed for the FT study-mode's valid teaching
-- days (Saturday through Wednesday, the academic week here starts
-- Saturday). Postgres requires ALTER TYPE ... ADD VALUE to not be used in
-- the same transaction it's added in; this migration only adds the value
-- and touches no rows, so that's not a concern here.
ALTER TYPE "DayOfWeek" ADD VALUE 'SUN';
