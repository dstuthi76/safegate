-- PLANTED: MIG010 (destructive drop) + XCHK001 (lib/legacy.ts still queries "legacyCode")
-- AlterTable
ALTER TABLE "Invoice" DROP COLUMN "legacyCode";
