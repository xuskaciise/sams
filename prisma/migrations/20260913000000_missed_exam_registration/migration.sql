-- Special Exam / Missed Exam Registration.
--
-- 1) New enums + missed_exam_records table — a pure registration/
--    reporting record of WHY a student missed a midterm/final exam. No
--    FK to Assessment/AssessmentResult anywhere — deliberately out of
--    scope, see the model's own doc comment in schema.prisma.
-- 2) New EXAM_OFFICE system role (read-only, university-wide) + two new
--    permission keys: exam.records.view (EXAM_OFFICE only) and
--    exam.records.manage (ADMIN + DEAN, mirrors DEFAULT_ROLE_GRANTS).
--    Idempotent throughout — same guarded INSERT ... WHERE NOT EXISTS
--    pattern as every prior role/permission-seeding migration
--    (20260722010000_dailylog_permissions, 20260718000000_close_semester_to_admin).

-- CreateEnum
CREATE TYPE "MissedExamType" AS ENUM ('MIDTERM', 'FINAL', 'BOTH');
CREATE TYPE "MissedExamReasonType" AS ENUM ('ILLNESS', 'CHEATING', 'EMERGENCY', 'OTHER');

-- CreateTable
CREATE TABLE "missed_exam_records" (
    "id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "semester_id" TEXT NOT NULL,
    "exam_type" "MissedExamType" NOT NULL,
    "reason_type" "MissedExamReasonType" NOT NULL,
    "reason_note" TEXT,
    "recorded_by" TEXT NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "missed_exam_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "missed_exam_records_student_id_idx" ON "missed_exam_records"("student_id");
CREATE INDEX "missed_exam_records_assignment_id_idx" ON "missed_exam_records"("assignment_id");
CREATE INDEX "missed_exam_records_semester_id_idx" ON "missed_exam_records"("semester_id");
CREATE INDEX "missed_exam_records_course_id_idx" ON "missed_exam_records"("course_id");

-- AddForeignKey
ALTER TABLE "missed_exam_records" ADD CONSTRAINT "missed_exam_records_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "missed_exam_records" ADD CONSTRAINT "missed_exam_records_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "missed_exam_records" ADD CONSTRAINT "missed_exam_records_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "lecturer_course_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "missed_exam_records" ADD CONSTRAINT "missed_exam_records_semester_id_fkey" FOREIGN KEY ("semester_id") REFERENCES "semesters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "missed_exam_records" ADD CONSTRAINT "missed_exam_records_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed the new EXAM_OFFICE system role (mirrors lib/permissions.ts's
-- SYSTEM_ROLES/SYSTEM_ROLE_DESCRIPTIONS). Idempotent on name.
INSERT INTO "roles" ("id", "name", "description", "is_system", "updated_at")
SELECT gen_random_uuid()::text, 'EXAM_OFFICE',
  'Read-only, university-wide view of missed/special exam registrations.',
  true, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "name" = 'EXAM_OFFICE');

-- Seed the two new permission keys (mirrors lib/permissions.ts)
INSERT INTO "permissions" ("id", "key", "description", "category")
SELECT gen_random_uuid()::text, v.key, v.description, v.category
FROM (VALUES
  ('exam.records.manage', 'Register missed/special exam records for students', 'Students'),
  ('exam.records.view', 'View missed/special exam records university-wide (read-only)', 'Students')
) AS v(key, description, category)
WHERE NOT EXISTS (SELECT 1 FROM "permissions" p WHERE p.key = v.key);

-- Grant exam.records.manage to ADMIN and DEAN
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "roles" r
JOIN "permissions" p ON p.key = 'exam.records.manage'
WHERE r.name IN ('ADMIN', 'DEAN')
  AND r.is_system = true
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );

-- Grant exam.records.view to EXAM_OFFICE only
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "roles" r
JOIN "permissions" p ON p.key = 'exam.records.view'
WHERE r.name = 'EXAM_OFFICE'
  AND r.is_system = true
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
