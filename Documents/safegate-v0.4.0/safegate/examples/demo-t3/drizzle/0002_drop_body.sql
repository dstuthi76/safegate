-- PLANTED: MIG010 (destructive drop) + XCHK001 (src/server/db/schema.ts still declares notes.body)
ALTER TABLE "demo_note" DROP COLUMN "body";
