-- Separate lecturer registration from account creation, mirroring the
-- earlier student_registration_split migration:
--   * lecturers.user_id becomes nullable — a Lecturer can exist with no
--     login account, created via the new Lecturer Registration page
--   * users.email becomes nullable — lecturer accounts generated from the
--     new Lecturer Accounts page use phone_number as their login
--     identifier (username) instead of email; ADMIN/DEAN/custom-role
--     staff accounts (created via Users) keep requiring one via
--     userFormSchema, unchanged
--   * lecturers.phone_number gets a uniqueness constraint (it's about to
--     double as a login identifier, same role student_no already plays)
--   * lecturers gains a nullable department_id — a plain profile field
--     (NOT a dean-scoping mechanism; dean_departments/lib/dean-scope.ts is
--     untouched), used to filter the Lecturer Accounts list and drive
--     "generate accounts by department"
--
-- No backfill: existing lecturer accounts (all still email-based, none
-- have a phone_number set — confirmed against the live DB before writing
-- this migration) are deliberately left exactly as they are and keep
-- logging in via email; nothing here changes how any existing account
-- authenticates.

ALTER TABLE "lecturers" ALTER COLUMN "user_id" DROP NOT NULL;

ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;

ALTER TABLE "lecturers" ADD COLUMN "department_id" TEXT;

CREATE INDEX "lecturers_department_id_idx" ON "lecturers"("department_id");

ALTER TABLE "lecturers" ADD CONSTRAINT "lecturers_department_id_fkey"
  FOREIGN KEY ("department_id") REFERENCES "departments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Safe: zero existing lecturers have a phone_number set (verified against
-- the live DB), so there is nothing that could violate this.
CREATE UNIQUE INDEX "lecturers_phone_number_key" ON "lecturers"("phone_number");
