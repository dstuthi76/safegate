-- SAFE: concurrent index in its own migration. Expected: no finding.
CREATE INDEX CONCURRENTLY "Post_authorId_idx" ON "Post"("authorId");
