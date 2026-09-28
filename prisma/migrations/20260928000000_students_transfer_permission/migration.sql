-- Seeds the students.transfer permission key (mirrors lib/permissions.ts)
-- for the single-student mid-semester class transfer, granted to ADMIN
-- and DEAN (a dean is additionally faculty-scoped in the action itself
-- via dean_departments — both the student's current class AND the target
-- class must be in their faculty). Idempotent, same guarded-INSERT
-- pattern as every prior permission-seed migration.

INSERT INTO "permissions" ("id", "key", "description", "category")
SELECT gen_random_uuid()::text, 'students.transfer',
  'Transfer a single student to another class mid-semester (moves their active-semester enrollments)',
  'Students'
WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "key" = 'students.transfer');

INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "roles" r
JOIN "permissions" p ON p.key = 'students.transfer'
WHERE r.name IN ('ADMIN', 'DEAN')
  AND r.is_system = true
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
