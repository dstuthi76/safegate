-- PLANTED: MIG002 (SET NOT NULL scans the table under ACCESS EXCLUSIVE lock)
ALTER TABLE "Invoice" ALTER COLUMN "currency" SET NOT NULL;

-- PLANTED: MIG005 (type change rewrites the table)
ALTER TABLE "Post" ALTER COLUMN "views" SET DATA TYPE BIGINT;

-- PLANTED: MIG004 (volatile default rewrites every row)
ALTER TABLE "AuditLog" ADD COLUMN "requestId" TEXT NOT NULL DEFAULT gen_random_uuid();

-- PLANTED: MIG006 (foreign key validated under lock on an existing table)
ALTER TABLE "AuditLog" ADD COLUMN "actorId" TEXT;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Safe: constant default on Postgres 11+ is instant. Expected: no finding.
ALTER TABLE "AuditLog" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'web';
