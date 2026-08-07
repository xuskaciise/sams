-- AlterTable
ALTER TABLE "lecturers" ADD COLUMN     "available_days" "DayOfWeek"[] DEFAULT ARRAY[]::"DayOfWeek"[];
