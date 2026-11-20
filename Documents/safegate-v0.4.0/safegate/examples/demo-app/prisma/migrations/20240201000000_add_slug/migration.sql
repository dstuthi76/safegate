-- PLANTED: MIG003 (required column without default fails on a non-empty table)
-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "slug" TEXT NOT NULL;

-- PLANTED: MIG001 (index on an existing table without CONCURRENTLY blocks writes)
-- CreateIndex
CREATE UNIQUE INDEX "Post_slug_key" ON "Post"("slug");
