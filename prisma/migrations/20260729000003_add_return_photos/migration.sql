-- AlterTable
ALTER TABLE "ReturnRequest" ADD COLUMN     "photos" TEXT[] DEFAULT ARRAY[]::TEXT[];
