import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import { createWorkspace, proposeFix } from "../src/ai/fix";
import { GeminiConfig, geminiConfigFromEnv, generateJson } from "../src/ai/gemini";
import { run } from "../src/index";
import { parseRepo } from "../src/server/github";
import { createApp } from "../src/server/server";
import { MemoryStore } from "../src/server/store";

const DEMO = path.resolve(__dirname, "../../examples/demo-app");

interface Recorded {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}
type Reply = { status?: number; json?: unknown; answer?: unknown };

/** A stand-in for the Gemini API: replies with queued answers and records what it was sent. */
async function mockGemini(replies: Reply[]) {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push({ url: req.url || "", headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const r = replies.shift() ?? { status: 500, json: { error: { message: "mock: no reply queued" } } };
      const payload = r.answer !== undefined ? { candidates: [{ content: { parts: [{ text: JSON.stringify(r.answer) }] }, finishReason: "STOP" }] } : r.json ?? {};
      res.writeHead(r.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cfg: GeminiConfig = { mode: "apikey", apiKey: "test-key", models: ["model-a", "model-b"], baseUrl, timeoutMs: 5000 };
  return { requests, cfg, baseUrl, close: () => new Promise((r) => server.close(r)) };
}

const SCHEMA = { type: "OBJECT", properties: { ok: { type: "BOOLEAN" } } };

test("gemini client: API-key request shape and JSON parsing", async () => {
  const m = await mockGemini([{ answer: { ok: true } }]);
  try {
    const res = await generateJson<{ ok: boolean }>(m.cfg, { system: "sys", prompt: "hello", schema: SCHEMA });
    assert.deepEqual(res, { data: { ok: true }, model: "model-a" });
    const r = m.requests[0];
    assert.equal(r.url, "/v1beta/models/model-a:generateContent");
    assert.equal(r.headers["x-goog-api-key"], "test-key");
    assert.equal(r.body.contents[0].role, "user");
    assert.equal(r.body.contents[0].parts[0].text, "hello");
    assert.equal(r.body.systemInstruction.parts[0].text, "sys");
    assert.equal(r.body.generationConfig.responseMimeType, "application/json");
    assert.deepEqual(r.body.generationConfig.responseSchema, SCHEMA);
  } finally {
    await m.close();
  }
});

test("gemini client: retries on 503, falls back to the next model on 404, reports 400", async () => {
  const m = await mockGemini([{ status: 503 }, { status: 404 }, { answer: { ok: true } }, { status: 400, json: { error: { message: "bad schema" } } }]);
  try {
    const res = await generateJson(m.cfg, { system: "s", prompt: "p", schema: SCHEMA });
    assert.equal(res.model, "model-b");
    assert.deepEqual(m.requests.map((r) => r.url.split("/").pop()), ["model-a:generateContent", "model-a:generateContent", "model-b:generateContent"]);
    await assert.rejects(generateJson(m.cfg, { system: "s", prompt: "p", schema: SCHEMA }), /400: bad schema/);
  } finally {
    await m.close();
  }
});

test("gemini client: Vertex AI mode uses the project endpoint and a bearer token", async () => {
  const m = await mockGemini([{ answer: { ok: true } }]);
  process.env.GOOGLE_ACCESS_TOKEN = "tok-123";
  try {
    const cfg = geminiConfigFromEnv({ GOOGLE_CLOUD_PROJECT: "my-proj", K_SERVICE: "safegate", SAFEGATE_GEMINI_BASE_URL: m.baseUrl, SAFEGATE_GEMINI_MODEL: "model-x" })!;
    assert.equal(cfg.mode, "vertex");
    await generateJson(cfg, { system: "s", prompt: "p", schema: SCHEMA });
    assert.equal(m.requests[0].url, "/v1/projects/my-proj/locations/global/publishers/google/models/model-x:generateContent");
    assert.equal(m.requests[0].headers.authorization, "Bearer tok-123");
  } finally {
    delete process.env.GOOGLE_ACCESS_TOKEN;
    await m.close();
  }
  assert.equal(geminiConfigFromEnv({}), null);
  assert.equal(geminiConfigFromEnv({ GEMINI_API_KEY: "k" })!.mode, "apikey");
});

const DELETE_LINE = "await prisma.post.delete({ where: { id: params.id } });";
const GOOD_FIX = { explanation: "Scopes the delete to the owner.", impact: "Anyone could delete any post.", edits: [{ find: DELETE_LINE, replace: "await prisma.post.delete({ where: { id: params.id, authorId: session.user.id } });" }] };

function demoFinding(ws: string, ruleId: string, fileIncludes: string) {
  const baseline = run({ root: ws }).findings;
  const finding = baseline.find((f) => f.ruleId === ruleId && f.file.includes(fileIncludes))!;
  assert.ok(finding, `demo finding ${ruleId} in ${fileIncludes}`);
  return { baseline, finding };
}

test("verified fix: wrong patches are rejected with feedback until one passes the re-scan", async () => {
  const ws = createWorkspace(DEMO);
  const m = await mockGemini([
    { answer: { explanation: "x", impact: "y", edits: [{ find: "this text is not in the file", replace: "z" }] } },
    { answer: { explanation: "x", impact: "y", edits: [{ find: DELETE_LINE, replace: "// TODO check owner\n  " + DELETE_LINE }] } },
    { answer: GOOD_FIX }
  ]);
  try {
    const { baseline, finding } = demoFinding(ws.dir, "AUTH003", "posts/[id]/route.ts");
    const before = fs.readFileSync(path.join(ws.dir, finding.file), "utf8");
    const p = await proposeFix(ws.dir, finding, baseline, m.cfg);
    assert.equal(p.status, "verified");
    assert.equal(p.attempts, 3);
    assert.match(p.diff, /^-\s+await prisma\.post\.delete\(\{ where: \{ id: params\.id \} \}\);$/m);
    assert.match(p.diff, /^\+.*authorId: session\.user\.id/m);
    assert.match(p.diff, /@@ line 31 @@/);
    // Feedback from each rejection reaches the next prompt.
    assert.match(m.requests[1].body.contents[0].parts[0].text, /occurs 0 times/);
    assert.match(m.requests[2].body.contents[0].parts[0].text, /still reports AUTH003/);
    // The prompt carries the finding, the file and the schema.
    const prompt = m.requests[0].body.contents[0].parts[0].text;
    assert.match(prompt, /Rule AUTH003/);
    assert.match(prompt, /model Post \{/);
    // The workspace is restored after verification.
    assert.equal(fs.readFileSync(path.join(ws.dir, finding.file), "utf8"), before);
  } finally {
    await m.close();
    ws.dispose();
  }
});

test("verified fix: ignore-comments, syntax errors and new findings are never accepted", async () => {
  const ws = createWorkspace(DEMO);
  const m = await mockGemini([
    { answer: { explanation: "x", impact: "y", edits: [{ find: DELETE_LINE, replace: "// safegate-ignore AUTH003 trust me\n  " + DELETE_LINE }] } },
    { answer: { explanation: "x", impact: "y", edits: [{ find: DELETE_LINE, replace: "await prisma.post.delete({ where: { id: params.id, authorId: session.user.id } );" }] } },
    // "Fixes" the delete by removing auth from the whole handler: AUTH003 goes away but AUTH001 appears.
    { answer: { explanation: "x", impact: "y", edits: [{ find: `  const session = await auth();\n  if (!session) return new Response("Unauthorized", { status: 401 });\n\n  ${DELETE_LINE}`, replace: `  ${DELETE_LINE}` }] } }
  ]);
  try {
    const { baseline, finding } = demoFinding(ws.dir, "AUTH003", "posts/[id]/route.ts");
    const p = await proposeFix(ws.dir, finding, baseline, m.cfg);
    assert.equal(p.status, "rejected");
    assert.match(m.requests[1].body.contents[0].parts[0].text, /not add a safegate-ignore comment/);
    assert.match(m.requests[2].body.contents[0].parts[0].text, /syntax error at line 31/);
    assert.match(p.reason!, /introduces new findings: AUTH001/);
    assert.equal(run({ root: ws.dir }).findings.length, baseline.length, "workspace unchanged after rejections");
  } finally {
    await m.close();
    ws.dispose();
  }
});

test("verified fix: a blocking index is moved into its own CONCURRENTLY migration", async () => {
  const ws = createWorkspace(DEMO);
  const index = `CREATE UNIQUE INDEX "Post_slug_key" ON "Post"("slug");`;
  const newPath = "prisma/migrations/20240201000001_post_slug_index/migration.sql";
  const m = await mockGemini([
    { answer: { explanation: "x", impact: "y", edits: [{ find: index, replace: "-- moved" }], newFiles: [{ path: "../../etc/evil.sql", content: "x" }] } },
    { answer: { explanation: "Moves the index.", impact: "Writes block.", edits: [{ find: index, replace: "-- index moved to 20240201000001_post_slug_index" }], newFiles: [{ path: newPath, content: `CREATE UNIQUE INDEX CONCURRENTLY "Post_slug_key" ON "Post"("slug");` }] } }
  ]);
  try {
    const { baseline, finding } = demoFinding(ws.dir, "MIG001", "add_slug");
    const p = await proposeFix(ws.dir, finding, baseline, m.cfg, { keep: true });
    assert.equal(p.status, "verified");
    assert.equal(p.attempts, 2);
    assert.match(m.requests[1].body.contents[0].parts[0].text, /is not allowed/);
    assert.match(p.diff, /\+\+\+ b\/prisma\/migrations\/20240201000001_post_slug_index\/migration\.sql/);
    // keep: true leaves the verified patch in the workspace
    assert.ok(fs.existsSync(path.join(ws.dir, newPath)));
    assert.equal(run({ root: ws.dir }).findings.filter((f) => f.ruleId === "MIG001").length, 0);
  } finally {
    await m.close();
    ws.dispose();
  }
});

test("verified fix: rules that need a human decision are skipped without calling Gemini", async () => {
  const ws = createWorkspace(DEMO);
  const m = await mockGemini([]);
  try {
    const { baseline, finding } = demoFinding(ws.dir, "MIG010", "drop_legacy");
    const p = await proposeFix(ws.dir, finding, baseline, m.cfg);
    assert.equal(p.status, "skipped");
    assert.equal(m.requests.length, 0);
  } finally {
    await m.close();
    ws.dispose();
  }
});

test("parseRepo accepts GitHub repos and rejects everything else", () => {
  assert.deepEqual(parseRepo("https://github.com/vercel/next.js"), { owner: "vercel", repo: "next.js", ref: null });
  assert.deepEqual(parseRepo("github.com/a/b.git"), { owner: "a", repo: "b", ref: null });
  assert.deepEqual(parseRepo("a/b/tree/feat/x-1"), { owner: "a", repo: "b", ref: "feat/x-1" });
  for (const bad of ["", "justname", "https://evil.com/a/b", "a/b/tree/../../x", "a/..", "a b/c", "http://169.254.169.254/latest", "a/b/blob/main/x.ts"]) {
    assert.equal(parseRepo(bad), null, bad);
  }
});

async function call(base: string, method: string, p: string, body?: unknown) {
  const res = await fetch(base + p, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, json, text, headers: res.headers };
}

test("web service: scan the demo, get a verified fix, serve the page, count usage", async () => {
  const m = await mockGemini([{ answer: GOOD_FIX }]);
  const store = new MemoryStore();
  const app = createApp({ GEMINI_API_KEY: "k", SAFEGATE_GEMINI_BASE_URL: m.baseUrl, SAFEGATE_GEMINI_MODEL: "model-a" }, store);
  const server = http.createServer(app.handler);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await call(base, "GET", "/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy")!, /default-src 'self'/);
    assert.match(page.text, /<script src="\/app\.js">/);
    assert.equal((await call(base, "GET", "/app.js")).status, 200);
    assert.deepEqual((await call(base, "GET", "/api/config")).json, { version: "0.2.0", ai: true, model: "model-a", aiMode: "apikey" });

    const scan = await call(base, "POST", "/api/scan", { demo: true });
    assert.equal(scan.status, 200);
    assert.equal(scan.json.findings.length, 17);
    const target = scan.json.findings.find((f: any) => f.ruleId === "AUTH003");
    assert.equal(target.fixable, true);
    assert.equal(target.snippet.find((s: any) => s.line === target.line).text.trim(), DELETE_LINE);
    assert.equal(scan.json.findings.find((f: any) => f.ruleId === "XCHK001").fixable, false);

    const fix = await call(base, "POST", "/api/fix", { scanId: scan.json.scanId, index: target.index });
    assert.equal(fix.status, 200);
    assert.equal(fix.json.status, "verified");
    assert.match(fix.json.diff, /authorId: session\.user\.id/);
    // Second request for the same finding is served from cache (the mock has no more replies).
    assert.equal((await call(base, "POST", "/api/fix", { scanId: scan.json.scanId, index: target.index })).json.status, "verified");

    assert.equal((await call(base, "POST", "/api/fix", { scanId: "nope", index: 0 })).status, 410);
    assert.equal((await call(base, "POST", "/api/scan", { repo: "https://evil.com/a/b" })).status, 400);
    assert.equal((await call(base, "POST", "/api/scan", "[1]" as any)).status, 400);
    assert.equal((await call(base, "GET", "/../package.json")).status, 404);

    const stats = (await call(base, "GET", "/api/stats")).json;
    assert.equal(stats.scans, 1);
    assert.equal(stats.findings, 17);
    assert.equal(stats.fixesVerified, 1);
    assert.equal(stats.byRule.AUTH001, 2);
  } finally {
    app.close();
    await new Promise((r) => server.close(r));
    await m.close();
  }
});

test("web service: downloads a GitHub tarball, drops symlinks and repo-supplied config, then scans", async () => {
  // Build a tarball shaped like GitHub's: one top-level folder, plus hostile extras.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safegate-tar-"));
  const top = path.join(tmp, "owner-repo-abc123");
  fs.cpSync(DEMO, top, { recursive: true });
  fs.symlinkSync("/etc/hostname", path.join(top, "lib", "link.ts"));
  fs.writeFileSync(path.join(top, "safegate.config.json"), JSON.stringify({ disabledRules: ["AUTH001", "AUTH002", "AUTH003"] }));
  execFileSync("tar", ["-czf", path.join(tmp, "repo.tar.gz"), "-C", tmp, "owner-repo-abc123"]);
  const seen: string[] = [];
  const gh = http.createServer((req, res) => {
    seen.push(req.url || "");
    if (req.url === "/repos/owner/repo/tarball/main") {
      res.writeHead(200, { "Content-Type": "application/gzip" });
      fs.createReadStream(path.join(tmp, "repo.tar.gz")).pipe(res);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => gh.listen(0, r));
  const app = createApp({ SAFEGATE_GITHUB_API_BASE: `http://127.0.0.1:${(gh.address() as AddressInfo).port}` }, new MemoryStore());
  const server = http.createServer(app.handler);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const scan = await call(base, "POST", "/api/scan", { repo: "https://github.com/owner/repo/tree/main" });
    assert.equal(scan.status, 200);
    assert.equal(scan.json.repo, "owner/repo@main");
    assert.equal(scan.json.findings.length, 17, "repo-supplied config must not disable rules");
    assert.deepEqual(seen, ["/repos/owner/repo/tarball/main"]);

    const missing = await call(base, "POST", "/api/scan", { repo: "owner/missing" });
    assert.equal(missing.status, 422);
    assert.match(missing.json.error, /not found/);

    // Without Gemini configured the fix endpoint says so.
    assert.equal((await call(base, "POST", "/api/fix", { scanId: scan.json.scanId, index: 0 })).status, 503);
    assert.equal((await call(base, "GET", "/api/config")).json.ai, false);
  } finally {
    app.close();
    await new Promise((r) => server.close(r));
    await new Promise((r) => gh.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
