#!/usr/bin/env bash
# Proves, on a real Postgres, that the migration patterns safegate flags really cause
# blocked writes, failed deploys or data loss, and that the suggested fixes avoid them.
#
# Usage:
#   DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres ./scripts/prove-migration-risks.sh
# Quick start with Docker:
#   docker run -d --name sg-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
#   DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres ./scripts/prove-migration-risks.sh
#
# WARNING: creates and drops a schema named safegate_proof. Never point this at production.
set -uo pipefail
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${DATABASE_URL:?Set DATABASE_URL to a throwaway Postgres database}"
ROWS="${ROWS:-300000}"
PASS=0
FAIL=0
q() { psql "$DB" -v ON_ERROR_STOP=1 -qtAX -c "SET search_path=safegate_proof; $1"; }
ok() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

reset() {
  psql "$DB" -qtAX -c "DROP SCHEMA IF EXISTS safegate_proof CASCADE; CREATE SCHEMA safegate_proof;" >/dev/null
  q "CREATE TABLE \"Post\" (id serial PRIMARY KEY, title text, bio text, \"authorId\" int);
     INSERT INTO \"Post\" (title, bio, \"authorId\") SELECT 'post ' || g, 'bio ' || g, g % 100 FROM generate_series(1, $ROWS) g;" >/dev/null
}

# Holds `stmt` inside an open transaction for 3 seconds (like a slow migration), while a second
# session tries `probe` with a 1-second lock_timeout. Prints BLOCKED or OK.
probe_while() {
  local stmt="$1" probe="$2"
  psql "$DB" -qtAX -c "SET search_path=safegate_proof; BEGIN; $stmt; SELECT pg_sleep(3); ROLLBACK;" >/dev/null 2>&1 &
  local holder=$!
  sleep 1
  if psql "$DB" -qtAX -c "SET search_path=safegate_proof; SET lock_timeout='1s'; $probe" >/dev/null 2>&1; then echo OK; else echo BLOCKED; fi
  wait "$holder"
}

echo "safegate migration risk proof (table size: $ROWS rows)"
echo

echo "MIG001  CREATE INDEX without CONCURRENTLY blocks writes"
reset
r=$(probe_while 'CREATE INDEX "Post_title_idx" ON "Post"(title)' "INSERT INTO \"Post\"(title) VALUES ('x')")
[ "$r" = BLOCKED ] && ok "INSERT was blocked while the index was being built" || bad "INSERT was not blocked ($r)"
# fix: CONCURRENTLY, with a writer running alongside the build
reset
psql "$DB" -qtAX -c 'SET search_path=safegate_proof; CREATE INDEX CONCURRENTLY "Post_title_idx" ON "Post"(title);' >/dev/null 2>&1 &
builder=$!
sleep 0.2
if q "SET lock_timeout='1s'; INSERT INTO \"Post\"(title) VALUES ('x');" >/dev/null 2>&1; then ok "with CONCURRENTLY, INSERT succeeded during the build"; else bad "INSERT failed even with CONCURRENTLY"; fi
wait "$builder"

echo "MIG002  SET NOT NULL locks out reads and writes"
reset
r=$(probe_while 'ALTER TABLE "Post" ALTER COLUMN title SET NOT NULL' 'SELECT count(*) FROM "Post"')
[ "$r" = BLOCKED ] && ok "even SELECT was blocked (ACCESS EXCLUSIVE lock)" || bad "SELECT was not blocked ($r)"
# fix: NOT VALID check + VALIDATE, then SET NOT NULL is metadata-only
reset
q 'ALTER TABLE "Post" ADD CONSTRAINT title_nn CHECK (title IS NOT NULL) NOT VALID;' >/dev/null
r=$(probe_while 'ALTER TABLE "Post" VALIDATE CONSTRAINT title_nn' "INSERT INTO \"Post\"(title) VALUES ('x')")
[ "$r" = OK ] && ok "with NOT VALID + VALIDATE, writes continued during validation" || bad "writes were blocked during VALIDATE ($r)"

echo "MIG003  NOT NULL column without DEFAULT fails on a non-empty table"
reset
if q 'ALTER TABLE "Post" ADD COLUMN slug text NOT NULL;' >/dev/null 2>&1; then bad "migration unexpectedly succeeded"; else ok "migration failed: this deploy would break"; fi
if q "ALTER TABLE \"Post\" ADD COLUMN slug text NOT NULL DEFAULT '';" >/dev/null 2>&1; then ok "with a constant DEFAULT it succeeds"; else bad "constant default also failed"; fi

echo "MIG006  FOREIGN KEY without NOT VALID blocks writes during validation"
reset
q 'CREATE TABLE "User"(id int PRIMARY KEY); INSERT INTO "User" SELECT g FROM generate_series(0,99) g;' >/dev/null
r=$(probe_while 'ALTER TABLE "Post" ADD CONSTRAINT fk FOREIGN KEY ("authorId") REFERENCES "User"(id)' "INSERT INTO \"Post\"(title, \"authorId\") VALUES ('x', 1)")
[ "$r" = BLOCKED ] && ok "INSERT was blocked while the foreign key was validated" || bad "INSERT was not blocked ($r)"

echo "MIG009  DROP + ADD instead of RENAME deletes the data"
reset
before=$(q 'SELECT count(bio) FROM "Post";')
q 'ALTER TABLE "Post" DROP COLUMN bio, ADD COLUMN about text;' >/dev/null
after=$(q 'SELECT count(about) FROM "Post";')
[ "$before" -gt 0 ] && [ "$after" -eq 0 ] && ok "$before values existed before, $after remain after the migration" || bad "before=$before after=$after"
reset
q 'ALTER TABLE "Post" RENAME COLUMN bio TO about;' >/dev/null
kept=$(q 'SELECT count(about) FROM "Post";')
[ "$kept" -eq "$before" ] && ok "with RENAME COLUMN all $kept values are kept" || bad "rename kept $kept of $before"

psql "$DB" -qtAX -c "DROP SCHEMA IF EXISTS safegate_proof CASCADE;" >/dev/null
echo
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
