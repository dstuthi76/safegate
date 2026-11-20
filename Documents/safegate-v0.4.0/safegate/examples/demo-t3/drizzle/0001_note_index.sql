-- PLANTED: MIG001 (blocking index on an existing table)
CREATE INDEX "note_created_by_idx" ON "demo_note" USING btree ("createdById");
