/*
  Warnings:

  - A unique constraint covering the columns `[providerId]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "provider" TEXT,
ADD COLUMN     "providerId" TEXT,
ALTER COLUMN "passwordHash" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_providerId_key" ON "User"("providerId");

-- CreateIndex
CREATE INDEX "User_provider_providerId_idx" ON "User"("provider", "providerId");
