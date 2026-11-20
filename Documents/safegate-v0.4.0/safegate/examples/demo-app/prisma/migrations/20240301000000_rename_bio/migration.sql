-- The developer renamed User.bio to User.about in schema.prisma.
-- Prisma generated DROP + ADD instead of a rename.
-- PLANTED: MIG009 (every existing bio is deleted)
-- AlterTable
ALTER TABLE "User" DROP COLUMN "bio",
ADD COLUMN     "about" TEXT;
