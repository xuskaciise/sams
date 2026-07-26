-- Extends Faculty Daily Log to LECTURER as a read-only "own leave
-- notices" view (mirrors results.view.own/reports.view.own/
-- assessment.view.own's "view.own" shape). Seeds the new permission key
-- and grants it to LECTURER only — ADMIN/DEAN already hold the broader
-- dailylog.view and don't need this narrower key. Idempotent, same
-- guard pattern as 20260722010000_dailylog_permissions.

INSERT INTO "permissions" ("id", "key", "description", "category")
SELECT gen_random_uuid()::text, v.key, v.description, v.category
FROM (VALUES
  ('dailylog.view.own', 'View own leave notices (lecturer)', 'Users & Security')
) AS v(key, description, category)
WHERE NOT EXISTS (SELECT 1 FROM "permissions" p WHERE p.key = v.key);

INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "roles" r
JOIN "permissions" p ON p.key = 'dailylog.view.own'
WHERE r.name = 'LECTURER'
  AND r.is_system = true
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
