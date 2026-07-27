-- Seeds the three Class Timetable permission keys (mirrors
-- lib/permissions.ts) and grants them to their default roles per
-- DEFAULT_ROLE_GRANTS: timetable.manage + timetable.view to ADMIN and
-- DEAN; timetable.view.own to LECTURER and STUDENT. Idempotent, same
-- guard pattern as 20260722010000_dailylog_permissions.

INSERT INTO "permissions" ("id", "key", "description", "category")
SELECT gen_random_uuid()::text, v.key, v.description, v.category
FROM (VALUES
  ('timetable.manage', 'Create, edit, and delete timetable slots and rooms', 'Timetable'),
  ('timetable.view', 'View the timetable across classes', 'Timetable'),
  ('timetable.view.own', 'View own timetable (lecturer or student)', 'Timetable')
) AS v(key, description, category)
WHERE NOT EXISTS (SELECT 1 FROM "permissions" p WHERE p.key = v.key);

INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "roles" r
JOIN "permissions" p ON p.key IN ('timetable.manage', 'timetable.view')
WHERE r.name IN ('ADMIN', 'DEAN')
  AND r.is_system = true
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );

INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "roles" r
JOIN "permissions" p ON p.key = 'timetable.view.own'
WHERE r.name IN ('LECTURER', 'STUDENT')
  AND r.is_system = true
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
