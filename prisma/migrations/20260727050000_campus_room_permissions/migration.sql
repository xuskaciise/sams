-- Splits Campus/Room management out of timetable.manage into their own
-- keys, granted to ADMIN only (mirrors lib/permissions.ts's
-- DEFAULT_ROLE_GRANTS). DEAN keeps timetable.manage/timetable.view
-- (scheduling classes into rooms, scoped to their faculty) but does NOT
-- get campus.manage/room.manage — the physical campus/room inventory is
-- centrally administered, same "ADMIN manages structure, DEAN operates
-- within it" split as structure.manage vs. Dean's narrower tools.
-- Idempotent, same guard pattern as every prior permission-seed
-- migration in this app.

INSERT INTO "permissions" ("id", "key", "description", "category")
SELECT gen_random_uuid()::text, v.key, v.description, v.category
FROM (VALUES
  ('campus.manage', 'Create, edit, and deactivate campuses', 'Timetable'),
  ('room.manage', 'Create, edit, and deactivate rooms (including bulk add)', 'Timetable')
) AS v(key, description, category)
WHERE NOT EXISTS (SELECT 1 FROM "permissions" p WHERE p.key = v.key);

INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "roles" r
JOIN "permissions" p ON p.key IN ('campus.manage', 'room.manage')
WHERE r.name = 'ADMIN'
  AND r.is_system = true
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
