-- Faculty-scoped deans: a dean's visible/actionable universe (classes,
-- students, enrollments, assignments, assessments, results, lecturers) is
-- scoped by which Departments ("faculties") they oversee. Schema-only —
-- no data backfill: every existing dean starts unassigned (sees nothing
-- until an admin picks at least one department for them, per the
-- "unassigned dean sees an empty state, never all data" rule).

-- CreateTable
CREATE TABLE "dean_departments" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dean_departments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dean_departments_user_id_department_id_key" ON "dean_departments"("user_id", "department_id");
CREATE INDEX "dean_departments_department_id_idx" ON "dean_departments"("department_id");

-- AddForeignKey
ALTER TABLE "dean_departments" ADD CONSTRAINT "dean_departments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dean_departments" ADD CONSTRAINT "dean_departments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
