import { test } from "node:test";
import * as assert from "node:assert/strict";
import { scan } from "./helpers";
import { fileRoute } from "../src/auth/entries";

const at = (findings: { ruleId: string; line: number; file: string }[]) => findings.map((f) => `${f.ruleId}:${f.file.split("/").pop()}:${f.line}`).sort();

test("file routes: URL paths per framework", () => {
  assert.deepEqual(fileRoute("app/routes/notes.$noteId.tsx")?.path, "/notes/:noteId");
  assert.deepEqual(fileRoute("app/routes/_auth.login.tsx")?.path, "/login");
  assert.deepEqual(fileRoute("src/routes/notes/[id]/+server.ts")?.path, "/notes/[id]");
  assert.deepEqual(fileRoute("src/routes/(app)/notes/+page.server.ts")?.exports, ["load", "actions"]);
  assert.deepEqual(fileRoute("server/api/notes/[id].delete.ts"), { framework: "Nuxt", path: "/api/notes/[id]", exports: ["default"], method: "DELETE" });
  assert.deepEqual(fileRoute("src/pages/api/notes/[id].ts")?.framework, "Astro");
});

test("Remix / React Router: loader IDOR, action without auth, requireUserId counts", () => {
  const f = scan({
    "app/routes/notes.$id.tsx": `import { json } from "@remix-run/node";
export async function loader({ request, params }) {
  await requireUserId(request);
  return json(await prisma.post.findUnique({ where: { id: params.id } }));
}
export async function action({ params }) {
  await prisma.post.delete({ where: { id: params.id } });
  return null;
}
export default function Note() { return null; }`
  });
  assert.deepEqual(at(f), ["AUTH001:notes.$id.tsx:6", "AUTH002:notes.$id.tsx:4"]);
});

test("SvelteKit: +server.ts and form actions; locals.user counts as auth", () => {
  const f = scan({
    "src/routes/api/posts/[id]/+server.ts": `export const DELETE = async ({ params, locals }) => {
  if (!locals.user) throw error(401);
  await prisma.post.delete({ where: { id: params.id } });
  return new Response(null);
};`,
    "src/routes/posts/+page.server.ts": `export const actions = {
  create: async ({ request }) => {
    const data = Object.fromEntries(await request.formData());
    await prisma.post.create({ data: { ...data } });
  }
};`
  });
  assert.deepEqual(at(f), ["AUTH001:+page.server.ts:2", "AUTH003:+server.ts:3", "AUTH004:+page.server.ts:4"]);
});

test("SvelteKit: hooks.server.ts that redirects anonymous users protects matching routes", () => {
  const f = scan({
    "src/hooks.server.ts": `export const handle = async ({ event, resolve }) => {
  event.locals.user = await getUserFromCookie(event.cookies);
  if (event.url.pathname.startsWith("/app") && !event.locals.user) throw redirect(303, "/login");
  return resolve(event);
};`,
    "src/routes/app/posts/+page.server.ts": `export const actions = { default: async () => { await prisma.post.deleteMany({ where: { published: false } }); } };`,
    "src/routes/api/posts/+server.ts": `export const POST = async ({ request }) => { await prisma.post.create({ data: { title: "x", authorId: "1" } }); return new Response(); };`
  });
  assert.deepEqual(at(f), ["AUTH001:+server.ts:1", "AUTH003:+page.server.ts:1"]);
});

test("Nuxt: defineEventHandler, method from file name, requireUserSession counts", () => {
  const f = scan({
    "server/api/posts/[id].delete.ts": `export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id");
  await prisma.post.delete({ where: { id } });
  return { ok: true };
});`,
    "server/api/posts/[id].get.ts": `export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event);
  return prisma.post.findFirst({ where: { id: getRouterParam(event, "id"), authorId: user.id } });
});`
  });
  assert.deepEqual(at(f), ["AUTH001:[id].delete.ts:1"]);
  assert.match(f[0].message, /DELETE \/api\/posts\/\[id\]/);
});

test("Astro and Qwik: named HTTP exports and routeAction$", () => {
  const f = scan({
    "src/pages/api/posts/[id].ts": `export const DELETE = async ({ params }) => {
  await prisma.post.delete({ where: { id: params.id } });
  return new Response(null);
};`,
    "src/routes/posts/index.tsx": `export const useDelete = routeAction$(async (data, { sharedMap }) => {
  const user = sharedMap.get("user");
  await prisma.post.deleteMany({ where: { id: data.id } });
});`
  });
  assert.deepEqual(at(f), ["AUTH001:[id].ts:1", "AUTH001:index.tsx:1"]);
});

test("GraphQL resolver map: context.user check, IDOR on args, unauthenticated mutation", () => {
  const f = scan({
    "src/graphql/resolvers.ts": `export const resolvers = {
  Query: {
    post: async (_parent, args, context) => {
      if (!context.user) throw new GraphQLError("Unauthorized");
      return prisma.post.findUnique({ where: { id: args.id } });
    },
    feed: () => prisma.post.findMany({ where: { published: true } }),
  },
  Mutation: {
    deletePost: (_p, { id }) => prisma.post.delete({ where: { id } }),
    async updatePost(_p, args, { user }) {
      return prisma.post.update({ where: { id: args.id, authorId: user.id }, data: { title: args.title } });
    },
  },
};`
  });
  assert.deepEqual(at(f), ["AUTH001:resolvers.ts:10", "AUTH002:resolvers.ts:5"]);
});

test("GraphQL: graphql-shield protects all resolvers; Pothos authScopes counts", () => {
  const f = scan({
    "src/permissions.ts": `import { shield, rule } from "graphql-shield";
export const permissions = shield({ Mutation: { "*": isAuthenticated } });`,
    "src/resolvers.ts": `export const resolvers = { Mutation: { deletePost: (_p, { id }) => prisma.post.deleteMany({ where: { id, published: false } }) } };`,
    "src/schema.ts": `builder.mutationField("removePost", (t) => t.field({ type: "Boolean", authScopes: { loggedIn: true }, resolve: async (_r, args) => { await prisma.post.delete({ where: { id: args.id } }); return true; } }));`
  });
  // shield and authScopes cover auth; the IDOR on removePost remains
  assert.deepEqual(at(f), ["AUTH003:resolvers.ts:1", "AUTH003:schema.ts:1"]);
});

test("NestJS: guards, global guard opt-out with @Public, DTO validation, service follow, roles", () => {
  const f = scan({
    "prisma/schema.prisma": "",
    "src/posts/post.entity.ts": `import { Entity, Column, PrimaryGeneratedColumn, ManyToOne } from "typeorm";
@Entity()
export class Post {
  @PrimaryGeneratedColumn() id: number;
  @Column() title: string;
  @ManyToOne(() => User) owner: User;
}`,
    "src/posts/posts.service.ts": `import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
@Injectable()
export class PostsService {
  constructor(@InjectRepository(Post) private readonly repo: Repository<Post>) {}
  findOne(id: number) {
    return this.repo.findOneBy({ id });
  }
  findMine(id: number, userId: number) {
    return this.repo.findOne({ where: { id, owner: { id: userId } } });
  }
  remove(id: number) {
    return this.repo.delete(id);
  }
  create(dto: CreatePostDto) {
    return this.repo.save(dto);
  }
}`,
    "src/posts/posts.controller.ts": `import { Controller, Get, Post, Delete, Param, Body, UseGuards } from "@nestjs/common";
@Controller("posts")
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  @UseGuards(JwtAuthGuard)
  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.postsService.findOne(+id);
  }

  @UseGuards(JwtAuthGuard)
  @Get("mine/:id")
  mine(@Param("id") id: string, @CurrentUser() user) {
    return this.postsService.findMine(+id, user.id);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.postsService.remove(+id);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  create(@Body() dto: CreatePostDto) {
    return this.postsService.create(dto);
  }
}`,
    "src/admin/admin.controller.ts": `@Controller("admin")
@UseGuards(JwtAuthGuard)
export class AdminController {
  constructor(private readonly postsService: PostsService) {}
  @Get("posts/:id")
  get(@Param("id") id: string) { return this.postsService.findMine(+id, 0); }
  @Roles(Role.Admin)
  @Get("ok")
  ok() { return this.postsService.findMine(1, 0); }
}`
  });
  assert.deepEqual(at(f), ["AUTH001:posts.controller.ts:18", "AUTH002:posts.service.ts:7", "AUTH005:admin.controller.ts:5"]);
});

test("NestJS: APP_GUARD protects every route except @Public ones", () => {
  const f = scan({
    "src/app.module.ts": `@Module({ providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }] }) export class AppModule {}`,
    "src/posts.controller.ts": `@Controller("posts")
export class PostsController {
  @Delete(":id")
  remove(@Param("id") id: string, @Req() req) {
    return prisma.post.deleteMany({ where: { id, authorId: req.user.id } });
  }
  @Public()
  @Post("import")
  import(@Body() body: any) {
    return prisma.post.create({ data: body });
  }
}`
  });
  assert.deepEqual(at(f), ["AUTH001:posts.controller.ts:7", "AUTH004:posts.controller.ts:10"]);
});

test("Express: req.user in the handler counts as auth evidence; Koa ctx.state.user too", () => {
  const f = scan({
    "src/server.ts": `import express from "express";
app.delete("/posts/:id", async (req, res) => {
  if (!req.user) return res.sendStatus(401);
  await prisma.post.deleteMany({ where: { id: req.params.id, authorId: req.user.id } });
  res.end();
});
router.post("/k/:id", async (ctx) => {
  if (!ctx.state.user) ctx.throw(401);
  await prisma.post.delete({ where: { id: ctx.params.id } });
});`
  });
  assert.deepEqual(at(f), ["AUTH003:server.ts:9"]);
});

test("TanStack Start: createServerFn handler without auth middleware", () => {
  const f = scan({
    "src/server/posts.ts": `export const deletePost = createServerFn({ method: "POST" })
  .validator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    await prisma.post.delete({ where: { id: data.id } });
  });
export const myPost = createServerFn().middleware([authMiddleware]).handler(async ({ context }) => prisma.post.findFirst({ where: { authorId: context.user.id } }));`
  });
  assert.deepEqual(at(f), ["AUTH001:posts.ts:1"]);
});
