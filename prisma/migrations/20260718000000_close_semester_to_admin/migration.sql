-- Business rule change: Close Semester moves from Dean to Admin as a
-- global calendar action. Re-grants the semester.close permission from
-- the DEAN system role to the ADMIN system role (mirrors the updated
-- DEFAULT_ROLE_GRANTS in lib/permissions.ts). No schema change — this
-- only touches the default system-role grant for the two ROLES that
-- were seeded with it originally; any custom role or per-user override
-- an admin has since configured is left untouched.

-- Revoke semester.close from DEAN (system role only)
DELETE FROM "role_permissions" rp
USING "roles" r, "permissions" p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND r.name = 'DEAN'
  AND r.is_system = true
  AND p.key = 'semester.close';

-- Grant semester.close to ADMIN (system role only), skipping if already granted
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "roles" r
JOIN "permissions" p ON p.key = 'semester.close'
WHERE r.name = 'ADMIN'
  AND r.is_system = true
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
