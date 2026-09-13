-- Seeds the new exam.records.delete permission key (mirrors
-- lib/permissions.ts) and grants it to the same default holders as
-- exam.records.manage (ADMIN + DEAN) — a separate key so an admin can
-- later hand someone exam.records.manage (create/edit) WITHOUT
-- exam.records.delete via a custom role or a per-user DENY override,
-- without touching this seed. Idempotent, same guarded-INSERT pattern as
-- every prior permission-seed migration
-- (20260913000000_missed_exam_registration).

INSERT INTO "permissions" ("id", "key", "description", "category")
SELECT gen_random_uuid()::text, 'exam.records.delete',
  'Delete missed/special exam records (separate from create/edit)',
  'Students'
WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "key" = 'exam.records.delete');

INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "roles" r
JOIN "permissions" p ON p.key = 'exam.records.delete'
WHERE r.name IN ('ADMIN', 'DEAN')
  AND r.is_system = true
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
