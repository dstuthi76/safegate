import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawn } from "child_process";
import * as path from "path";
import { createWorkspace, proposeFix } from "../src/ai/fix";
import { parseDrizzleText } from "../src/drizzle/schema";
import { run } from "../src/index";
import { ids, scan } from "./helpers";

const T3 = path.resolve(__dirname, "../../examples/demo-t3");
const DEMO = path.resolve(__dirname, "../../examples/demo-app");
const CLI = path.resolve(__dirname, "../src/cli.js");
const authOnly = { only: "auth" as const };
const migOnly = { only: "migrations" as const };

// ---------- Drizzle ----------

const DRIZZLE_SCHEMA = `import { pgTable, serial, text, boolean } from "drizzle-orm/pg-core";
export const posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  published: boolean("published").default(false),
  authorId: text("author_id").notNull(),
});
export const tags = pgTable("tags", { id: serial("id").primaryKey(), name: text("name") });
export const users = pgTable("users", { id: text("id").primaryKey(), role: text("role") });
`;

const drizzle = (body: string) => ({
  "prisma/schema.prisma": "",
  "db/schema.ts": DRIZZLE_SCHEMA,
  "app/api/posts/[id]/route.ts": `import { db } from "@/db";\nimport { posts, tags, users } from "@/db/schema";\nimport { and, eq, sql } from "drizzle-orm";\nimport { auth } from "@/auth";\n${body}`
});
const handler = (code: string) => drizzle(`export async function GET(req: Request, { params }: any) { const s = await auth(); const id = Number(params.id); ${code} }`);

test("drizzle schema: tables, SQL names, owner fields, and pgTableCreator prefixes", () => {
  const [posts, tags] = parseDrizzleText(DRIZZLE_SCHEMA, "db/schema.ts", ["authorId", "userId"]);
  assert.equal(posts.accessor, "posts");
  assert.equal(posts.dbName, "posts");
  assert.deepEqual(posts.ownerFields, ["authorId"]);
  assert.equal(posts.fields.find((f) => f.name === "authorId")!.dbName, "author_id");
  assert.deepEqual(tags.ownerFields, []);
  const t3 = parseDrizzleText(`import { pgTableCreator } from "drizzle-orm/pg-core";\nexport const createTable = pgTableCreator((name) => \`app_\${name}\`);\nexport const notes = createTable("note", (d) => ({ id: d.integer().primaryKey(), createdById: d.varchar({ length: 255 }) }));`, "s.ts", ["createdById"]);
  assert.equal(t3[0].dbName, "app_note");
  assert.deepEqual(t3[0].ownerFields, ["createdById"]);
  // snake_case keys still count as owners: user_id -> userId
  const snake = parseDrizzleText(`export const docs = pgTable("docs", { user_id: text("user_id") });`, "s.ts", ["userId"]);
  assert.deepEqual(snake[0].ownerFields, ["user_id"]);
});

test("drizzle AUTH002: reads by id without an owner filter", () => {
  assert.deepEqual(ids(scan(handler(`return db.select().from(posts).where(eq(posts.id, id));`), authOnly)), ["AUTH002"]);
  assert.deepEqual(ids(scan(handler(`return db.query.posts.findFirst({ where: eq(posts.id, id) });`), authOnly)), ["AUTH002"]);
  assert.deepEqual(ids(scan(handler(`return db.select().from(posts);`), authOnly)), ["AUTH002"]);
});

test("drizzle: owner-scoped, public, callback, object and sql filters are not flagged", () => {
  const safe = [
    `return db.select().from(posts).where(and(eq(posts.id, id), eq(posts.authorId, s.user.id)));`,
    `return db.query.posts.findFirst({ where: (p, { and, eq }) => and(eq(p.id, id), eq(p.authorId, s.user.id)) });`,
    `return db.query.posts.findFirst({ where: { id, authorId: s.user.id } });`,
    `return db.select().from(posts).where(sql\`\${posts.authorId} = \${s.user.id}\`);`,
    `return db.select().from(tags);`,
    `const p = await db.query.posts.findFirst({ where: eq(posts.id, id) }); if (p?.authorId !== s.user.id) throw new Error(); return p;`,
    `const cond = buildFilter(); return db.select().from(posts).where(cond);`
  ];
  for (const c of safe) assert.deepEqual(ids(scan(handler(c), authOnly)), [], c);
  // a filter on someone else's field is not an owner filter: eq(posts.id, s.user.id) compares the wrong column
  assert.deepEqual(ids(scan(handler(`return db.select().from(posts).where(eq(posts.id, s.userId));`), authOnly)), ["AUTH002"]);
  // public content without auth is fine
  assert.deepEqual(ids(scan(drizzle(`export async function GET(req: Request, { params }: any) { return db.select().from(posts).where(and(eq(posts.id, Number(params.id)), eq(posts.published, true))); }`), authOnly)), []);
});

test("drizzle AUTH003, AUTH004, AUTH001 on writes", () => {
  assert.deepEqual(ids(scan(handler(`await db.delete(posts).where(eq(posts.id, id));`), authOnly)), ["AUTH003"]);
  assert.deepEqual(ids(scan(handler(`await db.update(posts).set({ title: "x" }).where(eq(posts.id, id));`), authOnly)), ["AUTH003"]);
  assert.deepEqual(ids(scan(handler(`await db.delete(posts).where(and(eq(posts.id, id), eq(posts.authorId, s.user.id)));`), authOnly)), []);
  const body = scan(drizzle(`export async function PATCH(req: Request) { const s = await auth(); const body = await req.json(); await db.update(users).set(body).where(eq(users.id, s.user.id)); }`), authOnly);
  assert.deepEqual(ids(body), ["AUTH004"]);
  assert.equal(body[0].severity, "high", "users has a role column");
  const insert = scan(drizzle(`export async function POST(req: Request) { const body = await req.json(); await db.insert(posts).values(body); }`), authOnly);
  assert.deepEqual(ids(insert), ["AUTH001", "AUTH004"]);
  assert.match(insert.find((f) => f.ruleId === "AUTH001")!.message, /insert\(posts\)/);
});

// ---------- tRPC ----------

const router = (file: string, code: string) => ({ [file]: `import { z } from "zod";\nimport { createTRPCRouter, protectedProcedure, publicProcedure, adminProcedure, t } from "../trpc";\nexport const r = createTRPCRouter({\n${code}\n});` });
const posts = (code: string) => router("src/server/api/routers/post.ts", code);

test("tRPC: public procedures that write are AUTH001; protected ones are checked for IDOR", () => {
  const pub = scan(posts(`create: publicProcedure.input(z.object({ title: z.string() })).mutation(({ ctx, input }) => ctx.db.post.create({ data: { title: input.title, authorId: "x" } })),`), authOnly);
  assert.deepEqual(ids(pub), ["AUTH001"]);
  assert.match(pub[0].message, /tRPC procedure create/);
  assert.match(pub[0].fix, /protectedProcedure/);
  assert.deepEqual(ids(scan(posts(`byId: protectedProcedure.input(z.object({ id: z.string() })).query(({ ctx, input }) => ctx.db.post.findUnique({ where: { id: input.id } })),`), authOnly)), ["AUTH002"]);
  assert.deepEqual(ids(scan(posts(`byId: protectedProcedure.input(z.object({ id: z.string() })).query(({ ctx, input }) => ctx.db.post.findUnique({ where: { id: input.id, authorId: ctx.session.user.id } })),`), authOnly)), []);
});

test("tRPC: validated input is not mass assignment; .use(auth) and ctx.session count as auth", () => {
  assert.deepEqual(ids(scan(posts(`update: protectedProcedure.input(z.object({ id: z.string(), title: z.string() })).mutation(({ ctx, input }) => ctx.db.post.update({ where: { id: input.id, authorId: ctx.session.user.id }, data: input })),`), authOnly)), []);
  assert.deepEqual(ids(scan(posts(`tag: t.procedure.use(isAuthed).mutation(({ ctx }) => ctx.db.tag.create({ data: { name: "a" } })),`), authOnly)), []);
  assert.deepEqual(ids(scan(posts(`tag: publicProcedure.mutation(({ ctx }) => { if (!ctx.session) throw new Error(); return ctx.db.tag.create({ data: { name: "a" } }); }),`), authOnly)), []);
  // without .input(), a raw argument is still request data
  assert.deepEqual(ids(scan(posts(`raw: protectedProcedure.mutation(({ ctx, input }) => ctx.db.tag.create({ data: input })),`), authOnly)), ["AUTH004"]);
});

test("tRPC: admin routers need a role check unless built on an admin procedure", () => {
  const admin = (code: string) => router("src/server/api/routers/admin.ts", code);
  const f = scan(admin(`wipe: protectedProcedure.mutation(({ ctx }) => ctx.db.tag.deleteMany()),`), authOnly);
  assert.deepEqual(ids(f), ["AUTH005"]);
  assert.match(f[0].fix, /adminProcedure/);
  assert.deepEqual(ids(scan(admin(`wipe: adminProcedure.mutation(({ ctx }) => ctx.db.tag.deleteMany()),`), authOnly)), []);
});

// ---------- Hono, Fastify, Elysia ----------

const server = (code: string) => ({ "server/app.ts": `import { prisma } from "./db";\n${code}` });
const write = `await prisma.tag.create({ data: { name: "a" } }); return c.text("ok");`;

test("Hono: app.use with a path only protects routes under that path", () => {
  const f = scan(server(`app.use("/api/*", requireAuth);\napp.post("/api/tags", async (c) => { ${write} });\napp.post("/open/tags", async (c) => { ${write} });`), authOnly);
  assert.deepEqual(ids(f), ["AUTH001"]);
  assert.match(f[0].message, /POST \/open\/tags/);
  // middleware registered after the route does not protect it
  assert.deepEqual(ids(scan(server(`app.post("/api/tags", async (c) => { ${write} });\napp.use("/api/*", requireAuth);`), authOnly)), ["AUTH001"]);
  assert.deepEqual(ids(scan(server(`app.use("*", requireAuth);\napp.post("/tags", async (c) => { ${write} });`), authOnly)), []);
});

test("Fastify preHandler and Elysia beforeHandle options count as auth", () => {
  assert.deepEqual(ids(scan(server(`fastify.post("/tags", { preHandler: [fastify.authenticate] }, async (req, reply) => { await prisma.tag.create({ data: { name: "a" } }); });`), authOnly)), []);
  assert.deepEqual(ids(scan(server(`fastify.post("/tags", { schema: {} }, async (req, reply) => { await prisma.tag.create({ data: { name: "a" } }); });`), authOnly)), ["AUTH001"]);
  assert.deepEqual(ids(scan(server(`app.post("/tags", async ({ body }) => { await prisma.tag.create({ data: { name: "a" } }); }, { beforeHandle: requireAuth });`), authOnly)), []);
  assert.deepEqual(ids(scan(server(`app.post("/tags", async ({ body }) => { await prisma.tag.create({ data: { name: "a" } }); }, { detail: { summary: "x" } });`), authOnly)), ["AUTH001"]);
});

// ---------- Migration layouts ----------

const idx = `CREATE INDEX "posts_title_idx" ON "posts"("title");`;
const init = `CREATE TABLE "posts" ("id" TEXT NOT NULL, "title" TEXT);`;
const located = (files: Record<string, string>) => scan(files, migOnly).map((f) => `${f.ruleId} ${f.file}`).sort();

test("migrations: Supabase, Flyway, Diesel and nested folders are found", () => {
  assert.deepEqual(located({ "supabase/migrations/20240101000000_init.sql": init, "supabase/migrations/20240201000000_idx.sql": idx }), ["MIG001 supabase/migrations/20240201000000_idx.sql"]);
  assert.deepEqual(located({ "src/main/resources/db/migration/V1__init.sql": init, "src/main/resources/db/migration/V2__idx.sql": idx, "src/main/resources/db/migration/U2__idx.sql": `DROP INDEX "posts_title_idx";` }), ["MIG001 src/main/resources/db/migration/V2__idx.sql"]);
  assert.deepEqual(located({ "migrations/2024-01-01-000000_init/up.sql": init, "migrations/2024-01-01-000000_init/down.sql": `DROP TABLE "posts";`, "migrations/2024-02-01-000000_idx/up.sql": idx }), ["MIG001 migrations/2024-02-01-000000_idx/up.sql"]);
  assert.deepEqual(located({ "packages/db/migrations/0001_init.sql": init, "packages/db/migrations/0002_idx.sql": idx }), ["MIG001 packages/db/migrations/0002_idx.sql"]);
});

test("migrations: rollback scripts never run on deploy, so they are skipped", () => {
  // golang-migrate: separate .down.sql files
  assert.deepEqual(
    located({ "migrations/000001_init.up.sql": init, "migrations/000001_init.down.sql": `DROP TABLE "posts";`, "migrations/000002_idx.up.sql": idx, "migrations/000002_idx.down.sql": `DROP INDEX "posts_title_idx";` }),
    ["MIG001 migrations/000002_idx.up.sql"]
  );
  // dbmate: the rollback follows "-- migrate:down" in the same file
  assert.deepEqual(
    located({
      "db/migrations/20240101000000_init.sql": `-- migrate:up\n${init}\n\n-- migrate:down\nDROP TABLE "posts";\n`,
      "db/migrations/20240201000000_slug.sql": `-- migrate:up\nALTER TABLE "posts" ADD COLUMN "slug" TEXT NOT NULL;\n\n-- migrate:down\nALTER TABLE "posts" DROP COLUMN "slug";\n`
    }),
    ["MIG003 db/migrations/20240201000000_slug.sql"]
  );
});

test("migrations: Drizzle Kit fixes that need a new migration are skipped without calling Gemini", async () => {
  const ws = createWorkspace(T3);
  try {
    const baseline = run({ root: ws.dir }).findings;
    const finding = baseline.find((f) => f.ruleId === "MIG001")!;
    // An unreachable endpoint: any Gemini call would turn this into an error, not a skip.
    const p = await proposeFix(ws.dir, finding, baseline, { mode: "apikey", apiKey: "x", models: ["m"], baseUrl: "http://127.0.0.1:9", timeoutMs: 500 });
    assert.equal(p.status, "skipped");
    assert.match(p.reason!, /drizzle-kit generate --custom/);
  } finally {
    ws.dispose();
  }
});

// ---------- The T3 demo app ----------

const EXPECTED_T3 = [
  "AUTH001 src/server/api/routers/note.ts:25",
  "AUTH001 src/server/edge.ts:25",
  "AUTH002 src/server/api/routers/note.ts:15",
  "AUTH003 src/server/api/routers/note.ts:32",
  "AUTH004 src/server/edge.ts:14",
  "AUTH005 src/server/api/routers/admin.ts:6",
  "MIG001 drizzle/0001_note_index.sql:2",
  "MIG010 drizzle/0002_drop_body.sql:2",
  "XCHK001 drizzle/0002_drop_body.sql:2"
].sort();

test("T3 demo (tRPC + Drizzle + Hono + Drizzle Kit): finds exactly the planted bugs", () => {
  const summary = run({ root: T3 });
  const got = summary.findings.map((f) => `${f.ruleId} ${f.file}:${f.line}`).sort();
  assert.deepEqual({ missed: EXPECTED_T3.filter((e) => !got.includes(e)), extra: got.filter((g) => !EXPECTED_T3.includes(g)) }, { missed: [], extra: [] });
  assert.equal(summary.migrationsChecked, 3);
  assert.equal(summary.schemaFound, true);
});

// ---------- MCP connector ----------

function mcpSession(messages: object[], env: NodeJS.ProcessEnv = {}): Promise<Map<number, any>> {
  return new Promise((resolve, reject) => {
    const cleanEnv = { ...process.env, ...env };
    delete cleanEnv.GEMINI_API_KEY;
    delete cleanEnv.GOOGLE_API_KEY;
    const child = spawn(process.execPath, [CLI, "mcp"], { cwd: path.dirname(DEMO), env: cleanEnv, stdio: ["pipe", "pipe", "pipe"] });
    const replies = new Map<number, any>();
    let buf = "";
    const want = messages.filter((m: any) => m.id !== undefined).length;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out with ${replies.size}/${want} replies`));
    }, 20000);
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const msg = JSON.parse(line);
        replies.set(msg.id, msg);
        if (replies.size === want) {
          clearTimeout(timer);
          child.stdin.end();
        }
      }
    });
    child.on("close", () => resolve(replies));
    child.on("error", reject);
    for (const m of messages) child.stdin.write(JSON.stringify(m) + "\n");
  });
}

test("MCP connector: handshake, tools, scan, file filter, and clear errors", async () => {
  const call = (id: number, name: string, args: object) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const r = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    call(3, "safegate_scan", { path: "demo-app" }),
    call(4, "safegate_scan", { path: "demo-app", files: ["app/actions/posts.ts"] }),
    call(5, "safegate_fix", { path: "demo-app" }),
    call(6, "safegate_scan", { path: "does-not-exist" }),
    call(7, "nope", {}),
    { jsonrpc: "2.0", id: 8, method: "resources/list" },
    { jsonrpc: "2.0", id: 9, method: "ping" },
    call(10, "safegate_rules", {})
  ]);
  assert.equal(r.get(1).result.protocolVersion, "2025-06-18", "unknown versions fall back to one we support");
  assert.equal(r.get(1).result.serverInfo.name, "safegate");
  assert.deepEqual(r.get(2).result.tools.map((t: any) => t.name), ["safegate_scan", "safegate_fix", "safegate_rules"]);
  const scanned = JSON.parse(r.get(3).result.content[0].text);
  assert.equal(scanned.total, 17);
  assert.equal(scanned.checked.migrations, 6);
  const filtered = JSON.parse(r.get(4).result.content[0].text);
  assert.deepEqual(filtered.findings.map((f: any) => `${f.ruleId}:${f.line}`), ["AUTH001:8", "AUTH004:17"]);
  assert.equal(r.get(5).result.isError, true);
  assert.match(r.get(5).result.content[0].text, /GEMINI_API_KEY/);
  assert.equal(r.get(6).result.isError, true);
  assert.equal(r.get(7).error.code, -32602);
  assert.equal(r.get(8).error.code, -32601);
  assert.deepEqual(r.get(9).result, {});
  assert.match(r.get(10).result.content[0].text, /^AUTH001 \(high\)/);
});
