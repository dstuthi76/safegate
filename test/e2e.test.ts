import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "path";
import { execFileSync, spawnSync } from "child_process";
import { run } from "../src/index";

const DEMO = path.resolve(__dirname, "../../examples/demo-app");
const CLI = path.resolve(__dirname, "../src/cli.js");

/** Every planted bug in the demo app, and nothing else. Update this list when you add a planted bug. */
const EXPECTED = [
  "AUTH001 app/actions/posts.ts:8",
  "AUTH001 server/express.ts:14",
  "AUTH002 app/api/posts/[id]/route.ts:9",
  "AUTH002 server/express.ts:9",
  "AUTH003 app/api/posts/[id]/route.ts:31",
  "AUTH004 app/actions/posts.ts:17",
  "AUTH004 app/api/posts/[id]/route.ts:21",
  "AUTH005 app/api/admin/users/route.ts:5",
  "MIG001 prisma/migrations/20240201000000_add_slug/migration.sql:7",
  "MIG002 prisma/migrations/20240401000000_tighten/migration.sql:2",
  "MIG003 prisma/migrations/20240201000000_add_slug/migration.sql:3",
  "MIG004 prisma/migrations/20240401000000_tighten/migration.sql:8",
  "MIG005 prisma/migrations/20240401000000_tighten/migration.sql:5",
  "MIG006 prisma/migrations/20240401000000_tighten/migration.sql:12",
  "MIG009 prisma/migrations/20240301000000_rename_bio/migration.sql:5",
  "MIG010 prisma/migrations/20240501000000_drop_legacy/migration.sql:3",
  "XCHK001 prisma/migrations/20240501000000_drop_legacy/migration.sql:3"
].sort();

test("demo app: finds exactly the planted bugs (precision and recall = 100%)", () => {
  const summary = run({ root: DEMO });
  const got = summary.findings.map((f) => `${f.ruleId} ${f.file}:${f.line}`).sort();
  const missed = EXPECTED.filter((e) => !got.includes(e));
  const extra = got.filter((g) => !EXPECTED.includes(g));
  assert.deepEqual({ missed, extra }, { missed: [], extra: [] });
  assert.equal(summary.migrationsChecked, 6);
});

test("CLI exit codes follow --fail-on", () => {
  const high = spawnSync(process.execPath, [CLI, "check", "--root", DEMO, "--format", "json"], { encoding: "utf8" });
  assert.equal(high.status, 1);
  const none = spawnSync(process.execPath, [CLI, "check", "--root", DEMO, "--fail-on", "none"], { encoding: "utf8" });
  assert.equal(none.status, 0);
  const bad = spawnSync(process.execPath, [CLI, "check", "--format", "xml"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
});

test("CLI JSON and SARIF output are valid", () => {
  const json = JSON.parse(execFileSync(process.execPath, [CLI, "check", "--root", DEMO, "--format", "json", "--fail-on", "none"], { encoding: "utf8" }));
  assert.equal(json.summary.total, EXPECTED.length);
  const sarif = JSON.parse(execFileSync(process.execPath, [CLI, "check", "--root", DEMO, "--format", "sarif", "--fail-on", "none"], { encoding: "utf8" }));
  assert.equal(sarif.version, "2.1.0");
  assert.equal(sarif.runs[0].results.length, EXPECTED.length);
  const gh = execFileSync(process.execPath, [CLI, "check", "--root", DEMO, "--format", "github", "--fail-on", "none"], { encoding: "utf8" });
  assert.match(gh, /^::error file=app\/actions\/posts\.ts,line=8,title=AUTH001::/m);
});
