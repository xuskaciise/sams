-- Seeds shift.manage (mirrors lib/permissions.ts), granted to ADMIN only —
-- same reasoning as campus.manage/room.manage: shifts are a centrally
-- administered time-template convenience, not a per-faculty concern.
-- Idempotent, same guard pattern as every prior permission-seed migration.

INSERT INTO "permissions" ("id", "key", "description", "category")
SELECT gen_random_uuid()::text, v.key, v.description, v.category
FROM (VALUES
  ('shift.manage', 'Create, edit, and deactivate shift time templates', 'Timetable')
) AS v(key, description, category)
WHERE NOT EXISTS (SELECT 1 FROM "permissions" p WHERE p.key = v.key);

INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "roles" r
JOIN "permissions" p ON p.key = 'shift.manage'
WHERE r.name = 'ADMIN'
  AND r.is_system = true
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
