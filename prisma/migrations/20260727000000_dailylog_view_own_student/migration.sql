-- Extends the LECTURER-only dailylog.view.own permission (see
-- 20260723000000_dailylog_view_own) to STUDENT as well: a student can
-- now see LEAVE_NOTICE entries that name them (relatedStudentId), same
-- "view.own" shape, same read-only scope — never the full faculty log,
-- never write. No new permission row needed (dailylog.view.own already
-- exists from the LECTURER migration); this only adds the STUDENT grant.
-- Idempotent, same guard pattern as every prior dailylog migration.

INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "roles" r
JOIN "permissions" p ON p.key = 'dailylog.view.own'
WHERE r.name = 'STUDENT'
  AND r.is_system = true
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
