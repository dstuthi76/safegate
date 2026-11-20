import { test } from "node:test";
import * as assert from "node:assert/strict";
import { splitSql, unquoteIdent } from "../src/migrations/sql";
import { splitTopLevel } from "../src/migrations/rules";
import { parseSchemaText, buildSchema } from "../src/prisma/schema";
import { globToRegExp } from "../src/util/files";
import { stripComments } from "../src/crosscheck/dropped-columns";

test("splitSql ignores semicolons in strings, comments and dollar quotes", () => {
  const sql = `-- comment; still comment
INSERT INTO "t" VALUES ('a;b');
/* block ; */ CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; END $$ LANGUAGE plpgsql;
SELECT 1`;
  const stmts = splitSql(sql);
  assert.equal(stmts.length, 3);
  assert.equal(stmts[0].text, `INSERT INTO "t" VALUES ('a;b')`);
  assert.equal(stmts[0].line, 2);
  assert.match(stmts[1].text, /^CREATE FUNCTION/);
  assert.equal(stmts[1].line, 3);
  assert.equal(stmts[2].line, 4);
});

test("splitTopLevel splits ALTER TABLE actions but not inside parentheses", () => {
  assert.deepEqual(splitTopLevel(`DROP COLUMN "a", ADD COLUMN "b" NUMERIC(10,2), ADD CONSTRAINT c CHECK (x IN (1,2))`), [
    `DROP COLUMN "a"`,
    `ADD COLUMN "b" NUMERIC(10,2)`,
    `ADD CONSTRAINT c CHECK (x IN (1,2))`
  ]);
});

test("unquoteIdent handles schema prefixes and quotes", () => {
  assert.equal(unquoteIdent(`"public"."Post"`), "Post");
  assert.equal(unquoteIdent(`users`), "users");
});

test("schema parser finds owner fields, relations and @@map", () => {
  const models = parseSchemaText(
    `model Doc {
  id      String @id
  ownerId String @map("owner_id")
  owner   User   @relation(fields: [ownerId], references: [id])
  @@map("documents")
}
model User {
  id String @id
  docs Doc[]
}`,
    "schema.prisma",
    ["ownerId", "userId"]
  );
  const schema = buildSchema(models);
  const doc = schema.byAccessor.get("doc")!;
  assert.equal(doc.dbName, "documents");
  assert.deepEqual(doc.ownerFields, ["ownerId"]);
  assert.deepEqual(doc.ownerRelations, ["owner"]);
  assert.equal(doc.fields.find((f) => f.name === "ownerId")!.dbName, "owner_id");
  assert.equal(schema.byTable.get("documents"), doc);
});

test("globToRegExp", () => {
  assert.ok(globToRegExp("**/webhooks/**").test("app/api/webhooks/stripe/route.ts"));
  assert.ok(globToRegExp("node_modules/**").test("node_modules/x/y.js"));
  assert.ok(!globToRegExp("**/*.test.ts").test("src/a.ts"));
  assert.ok(globToRegExp("**/*.test.ts").test("src/a.test.ts"));
});

test("stripComments keeps line numbers and URLs", () => {
  const out = stripComments(`a // legacyCode\nconst u = "https://x.dev"; /* legacyCode */ b`);
  assert.ok(!out.includes("legacyCode"));
  assert.ok(out.includes("https://x.dev"));
  assert.equal(out.split("\n").length, 2);
});
