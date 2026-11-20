import { test } from "node:test";
import * as assert from "node:assert/strict";
import { ids, scan, scanMigration } from "./helpers";

test("MIG001: index on existing table without CONCURRENTLY", () => {
  assert.deepEqual(ids(scanMigration(`CREATE INDEX "Post_title_idx" ON "Post"("title");`)), ["MIG001"]);
  assert.deepEqual(ids(scanMigration(`CREATE UNIQUE INDEX CONCURRENTLY "Post_title_key" ON "Post"("title");`)), []);
});

test("MIG001 is not raised for tables created in the same migration", () => {
  assert.deepEqual(ids(scanMigration(`CREATE TABLE "New" ("id" TEXT);\nCREATE INDEX "New_id_idx" ON "New"("id");`)), []);
});

test("MIG002: SET NOT NULL", () => {
  assert.deepEqual(ids(scanMigration(`ALTER TABLE "Post" ALTER COLUMN "title" SET NOT NULL;`)), ["MIG002"]);
  assert.deepEqual(ids(scanMigration(`ALTER TABLE "Post" ALTER COLUMN "title" DROP NOT NULL;`)), []);
});

test("MIG003: required column without default", () => {
  assert.deepEqual(ids(scanMigration(`ALTER TABLE "Post" ADD COLUMN "slug" TEXT NOT NULL;`)), ["MIG003"]);
  assert.deepEqual(ids(scanMigration(`ALTER TABLE "Post" ADD COLUMN "slug" TEXT NOT NULL DEFAULT '';`)), []);
  assert.deepEqual(ids(scanMigration(`ALTER TABLE "Post" ADD COLUMN "slug" TEXT;`)), []);
});

test("MIG004: volatile default", () => {
  assert.deepEqual(ids(scanMigration(`ALTER TABLE "Post" ADD COLUMN "uid" UUID NOT NULL DEFAULT gen_random_uuid();`)), ["MIG004"]);
  assert.deepEqual(ids(scanMigration(`ALTER TABLE "Post" ADD COLUMN "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;`)), []);
});

test("MIG005: column type change", () => {
  assert.deepEqual(ids(scanMigration(`ALTER TABLE "Post" ALTER COLUMN "views" SET DATA TYPE BIGINT;`)), ["MIG005"]);
  assert.deepEqual(ids(scanMigration(`ALTER TABLE "Post" ALTER COLUMN "views" TYPE BIGINT USING "views"::bigint;`)), ["MIG005"]);
});

test("MIG006: foreign key / check without NOT VALID", () => {
  assert.deepEqual(ids(scanMigration(`ALTER TABLE "Post" ADD CONSTRAINT "fk" FOREIGN KEY ("authorId") REFERENCES "User"("id");`)), ["MIG006"]);
  assert.deepEqual(ids(scanMigration(`ALTER TABLE "Post" ADD CONSTRAINT "fk" FOREIGN KEY ("authorId") REFERENCES "User"("id") NOT VALID;`)), []);
  assert.deepEqual(ids(scanMigration(`ALTER TABLE "Post" ADD CONSTRAINT "c" CHECK ("views" >= 0);`)), ["MIG006"]);
});

test("MIG007: unique constraint builds an index under lock", () => {
  assert.deepEqual(ids(scanMigration(`ALTER TABLE "Post" ADD CONSTRAINT "Post_title_key" UNIQUE ("title");`)), ["MIG007"]);
  assert.deepEqual(ids(scanMigration(`ALTER TABLE "Post" ADD CONSTRAINT "Post_title_key" UNIQUE USING INDEX "Post_title_idx";`)), []);
});

test("MIG008: renames", () => {
  assert.deepEqual(ids(scanMigration(`ALTER TABLE "Post" RENAME COLUMN "title" TO "headline";`)), ["MIG008"]);
  assert.deepEqual(ids(scanMigration(`ALTER TABLE "Post" RENAME TO "Article";`)), ["MIG008"]);
});

test("MIG009: drop + add in one migration looks like a lossy rename", () => {
  assert.deepEqual(ids(scanMigration(`ALTER TABLE "User" DROP COLUMN "bio",\nADD COLUMN "about" TEXT;`)), ["MIG009"]);
});

test("MIG010: destructive drops", () => {
  assert.deepEqual(ids(scanMigration(`ALTER TABLE "Post" DROP COLUMN "views";`)), ["MIG010"]);
  assert.deepEqual(ids(scanMigration(`DROP TABLE "Post";`)), ["MIG010"]);
});

test("MIG011: drop index without CONCURRENTLY", () => {
  assert.deepEqual(ids(scanMigration(`DROP INDEX "Post_title_idx";`)), ["MIG011"]);
  assert.deepEqual(ids(scanMigration(`DROP INDEX CONCURRENTLY "Post_title_idx";`)), []);
});

test("finding line numbers point at the right statement", () => {
  const f = scanMigration(`-- header\n\nALTER TABLE "Post" ADD COLUMN "a" TEXT;\nCREATE INDEX "i" ON "Post"("a");`);
  assert.equal(f.length, 1);
  assert.equal(f[0].line, 4);
});

test("safegate-ignore in SQL suppresses a finding", () => {
  assert.deepEqual(ids(scanMigration(`-- safegate-ignore MIG001 table has 40 rows\nCREATE INDEX "i" ON "Post"("title");`)), []);
  assert.deepEqual(ids(scanMigration(`-- safegate-ignore MIG002 wrong rule id\nCREATE INDEX "i" ON "Post"("title");`)), ["MIG001"]);
});

test("XCHK001: dropped column still used in code, but not when only in a comment", () => {
  const files = {
    "prisma/migrations/001_init/migration.sql": `CREATE TABLE "Post" ("id" TEXT NOT NULL, "subtitle" TEXT);`,
    "prisma/migrations/002_drop/migration.sql": `ALTER TABLE "Post" DROP COLUMN "subtitle";`
  };
  const used = scan({ ...files, "lib/x.ts": `import { prisma } from "./db";\nexport const f = () => prisma.post.findMany({ select: { subtitle: true } });` }, { only: "migrations" });
  assert.deepEqual(ids(used), ["MIG010", "XCHK001"]);
  const commented = scan({ ...files, "lib/x.ts": `// we used to read post.subtitle\nexport const f = () => prisma.post.findMany();` }, { only: "migrations" });
  assert.deepEqual(ids(commented), ["MIG010"]);
});

test("XCHK001: schema.prisma still declares a dropped column", () => {
  const f = scan(
    {
      "prisma/migrations/001_init/migration.sql": `CREATE TABLE "Post" ("id" TEXT NOT NULL, "title" TEXT);`,
      "prisma/migrations/002_drop/migration.sql": `ALTER TABLE "Post" DROP COLUMN "title";`
    },
    { only: "migrations" }
  );
  const x = f.find((x) => x.ruleId === "XCHK001");
  assert.ok(x, "expected XCHK001");
  assert.match(x!.message, /schema\.prisma still declares Post\.title/);
});

test("XCHK001 is skipped when the column is re-added later", () => {
  const f = scan(
    {
      "prisma/migrations/001_init/migration.sql": `CREATE TABLE "Post" ("id" TEXT NOT NULL, "subtitle" TEXT);`,
      "prisma/migrations/002_drop/migration.sql": `ALTER TABLE "Post" DROP COLUMN "subtitle";`,
      "prisma/migrations/003_readd/migration.sql": `ALTER TABLE "Post" ADD COLUMN "subtitle" TEXT;`,
      "lib/x.ts": `export const f = () => prisma.post.findMany({ select: { subtitle: true } });`
    },
    { only: "migrations" }
  );
  assert.ok(!ids(f).includes("XCHK001"));
});
