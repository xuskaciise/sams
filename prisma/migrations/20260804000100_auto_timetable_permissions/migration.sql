-- Seeds workload.import and timetable.generate (mirrors lib/permissions.ts),
-- granted to both ADMIN and DEAN by default — same WHAT/WHERE split as
-- timetable.manage/timetable.view: a dean's run is scoped to their own
-- faculty's classes via dean_departments (lib/dean-scope.ts), re-derived
-- from the caller's role every call, not by these permission keys
-- themselves. Idempotent, same guard pattern as every prior permission-seed
-- migration.
INSERT INTO "permissions" ("id", "key", "description", "category")
SELECT gen_random_uuid()::text, v.key, v.description, v.category
FROM (VALUES
  ('workload.import', 'Import course-workload Excel files (creates lecturer-course assignments with credit hours)', 'Timetable'),
  ('timetable.generate', 'Run the sequential auto-timetable generator', 'Timetable')
) AS v(key, description, category)
WHERE NOT EXISTS (SELECT 1 FROM "permissions" p WHERE p.key = v.key);

INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "roles" r
JOIN "permissions" p ON p.key IN ('workload.import', 'timetable.generate')
WHERE r.name IN ('ADMIN', 'DEAN')
  AND r.is_system = true
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
