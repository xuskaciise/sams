-- Campus as a top-level entity Rooms belong to. Room.name's uniqueness
-- moves from global to per-campus ("Room 101" can now legitimately exist
-- at more than one campus — that's the whole point of showing
-- "Room name — Campus" in pickers).
--
-- Backfill decision (confirmed with the app owner, not guessed): the DB
-- had 4 pre-existing Room rows with no campus concept at all. A single
-- default "Main Campus" is created and every existing room is assigned
-- to it, so campus_id can go straight to NOT NULL in this same migration
-- rather than staying nullable pending manual assignment.

-- CreateTable
CREATE TABLE "campuses" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "campuses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "campuses_name_key" ON "campuses"("name");

-- Backfill: only creates "Main Campus" if there's actually a pre-existing
-- room to assign it to (a fresh DB with zero rooms gets no phantom
-- default campus).
INSERT INTO "campuses" ("id", "name", "address", "created_at")
SELECT gen_random_uuid()::text, 'Main Campus', NULL, CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "rooms")
  AND NOT EXISTS (SELECT 1 FROM "campuses" WHERE "name" = 'Main Campus');

-- AlterTable: nullable first so it can be backfilled, then tightened.
ALTER TABLE "rooms" ADD COLUMN "campus_id" TEXT;

UPDATE "rooms"
SET "campus_id" = (SELECT "id" FROM "campuses" WHERE "name" = 'Main Campus')
WHERE "campus_id" IS NULL;

ALTER TABLE "rooms" ALTER COLUMN "campus_id" SET NOT NULL;

-- Room.name uniqueness moves from global to per-campus.
DROP INDEX IF EXISTS "rooms_name_key";
CREATE UNIQUE INDEX "rooms_campus_id_name_key" ON "rooms"("campus_id", "name");
CREATE INDEX "rooms_campus_id_idx" ON "rooms"("campus_id");

ALTER TABLE "rooms" ADD CONSTRAINT "rooms_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
