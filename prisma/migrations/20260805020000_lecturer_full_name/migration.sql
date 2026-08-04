-- Lecturer gains its own full_name — mirrors the earlier
-- student_registration_split migration exactly (same reason: with
-- lecturers.user_id now nullable, every display of a lecturer's name
-- must work even when there is no linked user).

ALTER TABLE "lecturers" ADD COLUMN "full_name" TEXT;

UPDATE "lecturers" l
SET "full_name" = u."full_name"
FROM "users" u
WHERE l."user_id" = u."id";

ALTER TABLE "lecturers" ALTER COLUMN "full_name" SET NOT NULL;
