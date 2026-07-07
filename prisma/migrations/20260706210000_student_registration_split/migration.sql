-- Separate student registration from account creation:
--   * students.user_id becomes nullable — a Student can exist with no login
--   * students gets its own full_name (canonical, independent of any User)
--     and a nullable gender
--   * users gets a username (staff = email, students = student_no) so login
--     can accept either

-- 1. Gender enum + new nullable Student columns
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE');

ALTER TABLE "students" ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE "students" ADD COLUMN "full_name" TEXT;
ALTER TABLE "students" ADD COLUMN "gender" "Gender";

-- 2. Backfill full_name for existing students from their linked user
UPDATE "students" s
SET "full_name" = u."full_name"
FROM "users" u
WHERE s."user_id" = u."id";

ALTER TABLE "students" ALTER COLUMN "full_name" SET NOT NULL;

-- 3. username: default everyone to their email, then override students to
-- their student_no
ALTER TABLE "users" ADD COLUMN "username" TEXT;

UPDATE "users" SET "username" = "email";

UPDATE "users" u
SET "username" = s."student_no"
FROM "students" s
WHERE s."user_id" = u."id";

ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL;
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
