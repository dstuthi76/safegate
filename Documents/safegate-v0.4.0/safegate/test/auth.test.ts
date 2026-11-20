import { test } from "node:test";
import * as assert from "node:assert/strict";
import { ids, scan } from "./helpers";

const route = (body: string) => ({ "app/api/posts/[id]/route.ts": `import { prisma } from "@/lib/db";\nimport { auth } from "@/lib/auth";\n${body}` });
const authOnly = { only: "auth" as const };

test("AUTH001: route handler writes without auth", () => {
  const f = scan(route(`export async function POST(req: Request) { await prisma.post.create({ data: { title: "x", authorId: "1" } }); }`), authOnly);
  assert.deepEqual(ids(f), ["AUTH001"]);
  assert.equal(f[0].severity, "high");
});

test("AUTH001: server action without auth, file-level and inline 'use server'", () => {
  const file = scan({ "app/actions.ts": `"use server";\nexport async function del(id: string) { await prisma.post.delete({ where: { id } }); }` }, authOnly);
  assert.deepEqual(ids(file), ["AUTH001"]);
  const inline = scan({ "app/page.tsx": `export default function Page() {\n async function del(id: string) {\n "use server";\n await prisma.post.delete({ where: { id } });\n }\n return null;\n}` }, authOnly);
  assert.deepEqual(ids(inline), ["AUTH001"]);
});

test("AUTH001 not raised for webhooks, public reads, or wrapped handlers", () => {
  assert.deepEqual(ids(scan({ "app/api/webhooks/x/route.ts": `export async function POST() { await prisma.tag.create({ data: { name: "a" } }); }` }, authOnly)), []);
  assert.deepEqual(ids(scan(route(`export async function GET() { return prisma.post.findMany({ where: { published: true } }); }`), authOnly)), []);
  assert.deepEqual(ids(scan(route(`export const DELETE = withAuth(async (req, { params }) => { await prisma.post.delete({ where: { id: params.id, authorId: req.user.id } }); });`), authOnly)), []);
});

test("AUTH001 not raised when Next.js middleware protects the route", () => {
  const files = {
    ...route(`export async function POST(req: Request) { const s = await getSessionFromCookie(); await prisma.tag.create({ data: { name: "a" } }); }`),
    "middleware.ts": `import { auth } from "./auth";\nexport default auth((req) => {});\nexport const config = { matcher: ["/api/:path*"] };`
  };
  assert.deepEqual(ids(scan(files, authOnly)), []);
  const outside = { ...files, "middleware.ts": files["middleware.ts"].replace("/api/:path*", "/dashboard/:path*") };
  assert.deepEqual(ids(scan(outside, authOnly)), ["AUTH001"]);
});

test("auth via a same-file helper counts", () => {
  const f = scan(route(`async function requireOwner() { const s = await auth(); if (!s) throw new Error(); return s; }\nexport async function POST() { const s = await requireOwner(); await prisma.post.create({ data: { title: "x", authorId: s.user.id } }); }`), authOnly);
  assert.deepEqual(ids(f), []);
});

test("AUTH002: read by id without owner scope", () => {
  const f = scan(route(`export async function GET(req: Request, { params }: any) { const s = await auth(); return prisma.post.findUnique({ where: { id: params.id } }); }`), authOnly);
  assert.deepEqual(ids(f), ["AUTH002"]);
});

test("AUTH002: findMany with no where on an owned model", () => {
  const f = scan(route(`export async function GET() { const s = await auth(); return prisma.post.findMany(); }`), authOnly);
  assert.deepEqual(ids(f), ["AUTH002"]);
});

test("AUTH002 not raised when scoped by owner field, relation, or later comparison", () => {
  const cases = [
    `return prisma.post.findUnique({ where: { id: params.id, authorId: s.user.id } });`,
    `return prisma.post.findFirst({ where: { id: params.id, author: { id: s.user.id } } });`,
    `return prisma.post.findFirst({ where: { AND: [{ id: params.id }, { authorId: s.user.id }] } });`,
    `const p = await prisma.post.findUnique({ where: { id: params.id } }); if (p?.authorId !== s.user.id) throw new Error(); return p;`,
    `return prisma.tag.findUnique({ where: { id: params.id } });`,
    `const where = buildWhere(); return prisma.post.findFirst({ where });`
  ];
  for (const c of cases) {
    const f = scan(route(`export async function GET(req: Request, { params }: any) { const s = await auth(); ${c} }`), authOnly);
    assert.deepEqual(ids(f), [], c);
  }
});

test("AUTH003: update/delete without owner scope; fine after an owned lookup", () => {
  assert.deepEqual(ids(scan(route(`export async function DELETE(r: Request, { params }: any) { await auth(); await prisma.post.delete({ where: { id: params.id } }); }`), authOnly)), ["AUTH003"]);
  assert.deepEqual(ids(scan(route(`export async function PUT(r: Request, { params }: any) { await auth(); await prisma.post.updateMany({ where: { published: false }, data: { title: "x" } }); }`), authOnly)), ["AUTH003"]);
  const safe = `export async function DELETE(r: Request, { params }: any) { const s = await auth(); const p = await prisma.post.findFirst({ where: { id: params.id, authorId: s.user.id } }); if (!p) return; await prisma.post.delete({ where: { id: p.id } }); }`;
  assert.deepEqual(ids(scan(route(safe), authOnly)), []);
  const checkAfter = `export async function DELETE(r: Request, { params }: any) { const s = await auth(); await prisma.post.delete({ where: { id: params.id } }); const p = { authorId: "" }; if (p.authorId !== s.user.id) {} }`;
  assert.deepEqual(ids(scan(route(checkAfter), authOnly)), ["AUTH003"], "an ownership check after the delete is too late");
});

test("AUTH004: mass assignment from request body, spreads and action params", () => {
  assert.deepEqual(ids(scan(route(`export async function PATCH(req: Request) { const s = await auth(); const body = await req.json(); await prisma.post.update({ where: { id: body.id, authorId: s.user.id }, data: body }); }`), authOnly)), ["AUTH004"]);
  assert.deepEqual(ids(scan(route(`export async function PATCH(req: Request) { const s = await auth(); const body = await req.json(); await prisma.post.update({ where: { id: "1", authorId: s.user.id }, data: { ...body, authorId: s.user.id } }); }`), authOnly)), ["AUTH004"]);
  const action = scan({ "app/actions.ts": `"use server";\nexport async function save(data: any) { const s = await auth(); await prisma.user.update({ where: { id: s.user.id }, data }); }` }, authOnly);
  assert.deepEqual(ids(action), ["AUTH004"]);
  assert.equal(action[0].severity, "high", "User has a sensitive role field");
});

test("AUTH004 not raised for validated or explicit data", () => {
  const cases = [
    `const input = Schema.parse(await req.json()); await prisma.post.update({ where: { id: "1", authorId: s.user.id }, data: input });`,
    `const body = await req.json(); await prisma.post.update({ where: { id: "1", authorId: s.user.id }, data: { title: body.title } });`,
    `const defaults = { title: "Untitled" }; await prisma.post.create({ data: { ...defaults, authorId: s.user.id } });`
  ];
  for (const c of cases) {
    assert.deepEqual(ids(scan(route(`export async function PATCH(req: Request) { const s = await auth(); ${c} }`), authOnly)), [], c);
  }
});

test("AUTH005: admin route without role check", () => {
  const admin = (body: string) => ({ "app/api/admin/tags/route.ts": body });
  assert.deepEqual(ids(scan(admin(`export async function DELETE() { const s = await auth(); await prisma.tag.deleteMany(); }`), authOnly)), ["AUTH005"]);
  assert.deepEqual(ids(scan(admin(`export async function DELETE() { const s = await auth(); if (s.user.role !== "ADMIN") throw 1; await prisma.tag.deleteMany(); }`), authOnly)), []);
  assert.deepEqual(ids(scan(admin(`export async function DELETE() { const s = await requireAdmin(); await prisma.tag.deleteMany(); }`), authOnly)), []);
});

test("Express: middleware, router.use(auth), and IDOR", () => {
  const app = (code: string) => ({ "server/app.ts": `import { prisma } from "./db";\n${code}` });
  assert.deepEqual(ids(scan(app(`router.post("/tags", async (req, res) => { await prisma.tag.create({ data: { name: "a" } }); });`), authOnly)), ["AUTH001"]);
  assert.deepEqual(ids(scan(app(`router.post("/tags", requireAuth, async (req, res) => { await prisma.tag.create({ data: { name: "a" } }); });`), authOnly)), []);
  assert.deepEqual(ids(scan(app(`router.use(passport.authenticate("jwt"));\nrouter.post("/tags", async (req, res) => { await prisma.tag.create({ data: { name: "a" } }); });`), authOnly)), []);
  assert.deepEqual(ids(scan(app(`router.get("/posts/:id", requireAuth, async (req, res) => { res.json(await prisma.post.findUnique({ where: { id: req.params.id } })); });`), authOnly)), ["AUTH002"]);
  assert.deepEqual(ids(scan(app(`cache.get("posts", () => prisma.tag.create({ data: { name: "a" } }));`), authOnly)), [], "only string paths starting with / are routes");
});

test("safegate-ignore comment suppresses an auth finding", () => {
  const f = scan(route(`export async function GET(req: Request, { params }: any) { const s = await auth();\n // safegate-ignore AUTH002 public share link\n return prisma.post.findUnique({ where: { id: params.id } }); }`), authOnly);
  assert.deepEqual(ids(f), []);
});
