-- CreateEnum
CREATE TYPE "Period" AS ENUM ('MORNING', 'AFTERNOON');

-- DropForeignKey
ALTER TABLE "lecturers" DROP CONSTRAINT "lecturers_user_id_fkey";

-- AlterTable
ALTER TABLE "classes" ADD COLUMN     "period" "Period";

-- AlterTable
ALTER TABLE "shifts" ADD COLUMN     "period" "Period";

-- AddForeignKey
ALTER TABLE "lecturers" ADD CONSTRAINT "lecturers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
