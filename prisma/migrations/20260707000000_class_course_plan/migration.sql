-- Reusable curriculum template: a class's planned course list, consumed by
-- the "Open semester" wizard to bulk-create LecturerCourseAssignments.

CREATE TABLE "class_course_plans" (
    "id" TEXT NOT NULL,
    "class_id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "class_course_plans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "class_course_plans_class_id_course_id_key" ON "class_course_plans"("class_id", "course_id");

ALTER TABLE "class_course_plans" ADD CONSTRAINT "class_course_plans_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "class_course_plans" ADD CONSTRAINT "class_course_plans_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
