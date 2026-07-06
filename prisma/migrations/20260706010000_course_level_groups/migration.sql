-- Groups become course-level (LecturerCourseAssignment-scoped) instead of
-- assessment-scoped. Existing groups/members are migrated by mapping each
-- old assessment_id through assessments.assignment_id.

-- 1. Add new nullable columns
ALTER TABLE "student_groups" ADD COLUMN "assignment_id" TEXT;
ALTER TABLE "group_members" ADD COLUMN "assignment_id" TEXT;

-- 2. Backfill from existing data via the owning assessment
UPDATE "student_groups" sg
SET "assignment_id" = a."assignment_id"
FROM "assessments" a
WHERE sg."assessment_id" = a."id";

UPDATE "group_members" gm
SET "assignment_id" = a."assignment_id"
FROM "assessments" a
WHERE gm."assessment_id" = a."id";

-- 3. Drop old constraints/indexes referencing assessment_id
ALTER TABLE "student_groups" DROP CONSTRAINT "student_groups_assessment_id_fkey";
DROP INDEX "student_groups_assessment_id_name_key";
DROP INDEX "group_members_assessment_id_student_id_key";

-- 4. Drop old columns
ALTER TABLE "student_groups" DROP COLUMN "assessment_id";
ALTER TABLE "group_members" DROP COLUMN "assessment_id";

-- 5. Enforce NOT NULL now that backfill is complete
ALTER TABLE "student_groups" ALTER COLUMN "assignment_id" SET NOT NULL;
ALTER TABLE "group_members" ALTER COLUMN "assignment_id" SET NOT NULL;

-- 6. New constraints/indexes on assignment_id
ALTER TABLE "student_groups" ADD CONSTRAINT "student_groups_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "lecturer_course_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "student_groups_assignment_id_name_key" ON "student_groups"("assignment_id", "name");
CREATE UNIQUE INDEX "group_members_assignment_id_student_id_key" ON "group_members"("assignment_id", "student_id");
