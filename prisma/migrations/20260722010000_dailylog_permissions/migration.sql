-- Seeds the two new Daily Log permission keys (mirrors lib/permissions.ts)
-- and grants both to the ADMIN and DEAN system roles, matching
-- DEFAULT_ROLE_GRANTS. Idempotent: skips a permission that already
-- exists (by key) and skips a role_permissions row that's already
-- present, same guard pattern as 20260718000000_close_semester_to_admin.

-- Seed the permission catalog
INSERT INTO "permissions" ("id", "key", "description", "category")
SELECT gen_random_uuid()::text, v.key, v.description, v.category
FROM (VALUES
  ('dailylog.create', 'Create daily log entries (leave notices, problems, notes)', 'Users & Security'),
  ('dailylog.view', 'View daily log entries', 'Users & Security')
) AS v(key, description, category)
WHERE NOT EXISTS (SELECT 1 FROM "permissions" p WHERE p.key = v.key);

-- Grant both to ADMIN and DEAN (system roles only)
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "roles" r
JOIN "permissions" p ON p.key IN ('dailylog.create', 'dailylog.view')
WHERE r.name IN ('ADMIN', 'DEAN')
  AND r.is_system = true
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
