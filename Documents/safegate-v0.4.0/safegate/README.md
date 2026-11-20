# safegate

**A pull-request safety gate for TypeScript/JavaScript backends (Prisma, Drizzle, TypeORM, Sequelize, Mongoose, Kysely, Knex) and for Postgres migrations in SQL, Rails, Django, Alembic, Laravel and Node tools.**
It catches the auth bugs AI coding tools keep writing, and the migrations that lock or wipe production tables, before they merge.

```
HIGH   AUTH003  app/api/posts/[id]/route.ts:31
       DELETE /api/posts/[id] runs post.delete() on Post without scoping it to authorId.
       Any logged-in user can delete another user's Post by changing the id.
       fix: Add authorId: session.user.id to the where clause ...

HIGH   MIG001  prisma/migrations/20240201000000_add_slug/migration.sql:7
       Index Post_slug_key on existing table "Post" is built without CONCURRENTLY,
       so INSERT/UPDATE/DELETE on "Post" wait until it finishes.
```

- **Deterministic detection.** Finding bugs uses no LLM and no network: the same input always gives the same output, and your code stays on your machine.
- **Verified fixes from Gemini (optional).** `safegate fix` asks Gemini for a patch, applies it to a scratch copy and re-scans. You only see patches that remove the finding and add no new one.
- **Schema-aware.** It reads `schema.prisma` or your Drizzle tables to learn which data belongs to a user (`userId`, `authorId`, `orgId`...). That is what keeps false positives low.
- **Works on private repositories.** The CLI, GitHub Action and MCP connector all run on your machine or in your own CI, so your code is not uploaded anywhere.
- **Code ↔ migration cross-check.** It flags a migration that drops a column your code still reads, which SQL-only linters cannot see.

## Quick start

```bash
git clone <your-repo-url> safegate && cd safegate
npm install
npm run build
node dist/src/cli.js check --root /path/to/your/app          # find problems
GEMINI_API_KEY=... node dist/src/cli.js fix --root /path/to/your/app   # get verified patches
GEMINI_API_KEY=... node dist/src/cli.js serve                 # web page on http://localhost:8080
```

Requires Node 20+. The only dependency is `typescript` (used as a parser). Get a Gemini key at <https://aistudio.google.com/apikey>.

## Verified fixes with Gemini

```
VERIFIED  AUTH003  app/api/posts/[id]/route.ts:31  (attempts: 1)
--- a/app/api/posts/[id]/route.ts
+++ b/app/api/posts/[id]/route.ts
@@ line 31 @@
-  await prisma.post.delete({ where: { id: params.id } });
+  await prisma.post.delete({ where: { id: params.id, authorId: session.user.id } });
```

A patch is marked verified only when all four hold:

1. every edit matches the file exactly, once;
2. the patched TypeScript still parses;
3. the original finding is gone after a full re-scan;
4. no new finding of any rule appeared.

A rejected patch is sent back to Gemini with the reason, up to three attempts. Patches that add a `safegate-ignore` comment are always rejected. "Verified" means the checker passes; a person should still review the diff before merging.

| Command | What it does |
|---|---|
| `safegate fix` | Show verified patches for up to 10 findings |
| `safegate fix --apply` | Write verified patches into your files |
| `safegate fix --rule AUTH003 --max 3` | Limit by rule and count |
| `safegate fix --base origin/main --format markdown --output fixes.md` | PR mode, as a comment body |

Not auto-fixed, because they need a human decision: `MIG008` (rename), `MIG010` (drop), `XCHK001` (dropped column still used).

**What is sent to Gemini:** only when you run `fix` or click "Fix with Gemini": the one affected file, your Prisma schema, and the finding. `check` sends nothing anywhere.

**Auth:** `GEMINI_API_KEY` (Google AI Studio), or on Google Cloud `GOOGLE_CLOUD_PROJECT` + `GOOGLE_GENAI_USE_VERTEXAI=true` (Vertex AI, no key). Model: `SAFEGATE_GEMINI_MODEL` (default `gemini-3.8-flash,gemini-3.6-flash`, tried in order).

## Supported stacks

| Layer | Supported |
|---|---|
| Frameworks | Next.js (route handlers, server actions, `pages/api`, `middleware.ts` / `proxy.ts`), tRPC, Express, Hono, Fastify, Koa, Elysia, **NestJS** (controllers and resolvers, guards, global `APP_GUARD` with `@Public()`, DTO validation, and one step into `@Injectable` services), **GraphQL** (Apollo / Yoga / Mercurius resolver maps, Pothos, Nexus, graphql-shield), **Remix / React Router** (`loader`, `action`), **SvelteKit** (`+server`, `load`, form `actions`, `hooks.server`), **Nuxt / Nitro** (`server/api`, `server/routes`, server middleware), **Astro**, **SolidStart**, **Qwik** (`routeLoader$`, `routeAction$`), **TanStack Start** (`createServerFn`) |
| Data access | Prisma, Drizzle, **TypeORM** (repositories, `getRepository`, EntityManager, Active Record), **MikroORM**, **Sequelize**, **Mongoose**, **Kysely**, **Knex** |
| Data models (who owns a row) | `schema.prisma`, Drizzle tables, TypeORM / MikroORM `@Entity` (including `@ManyToOne(() => User)`), Sequelize `Model.init` / `define` / `belongsTo`, Mongoose `Schema` with `ref: "User"` and Nest `@Schema`, and tables created by SQL or Knex migrations (for Knex, Kysely and other query builders) |
| Migrations (Postgres) | SQL from Prisma, Drizzle Kit, Supabase, Flyway, golang-migrate, dbmate, Diesel and any `migrations` folder; **code migrations** from Rails, Django, Alembic, Laravel, Knex, Sequelize, TypeORM and node-pg-migrate (schema operations plus the raw SQL inside them). Only the "up" direction is checked |

The migration rules work for any Postgres project, whatever its language. The access-control rules read TypeScript and JavaScript.

Not yet supported for access control: Python (Django, FastAPI, Flask), Ruby on Rails, PHP (Laravel), Go and Java application code.

## Use it from an AI assistant (MCP connector)

`safegate mcp` runs safegate as an [MCP](https://modelcontextprotocol.io) server over stdio. Any MCP client can start it: Claude Code, Claude Desktop, Gemini CLI, Cursor, Antigravity and others. It runs on your computer, so it works on private repositories without uploading them.

Tools it offers:

| Tool | What it does |
|---|---|
| `safegate_scan` | Scan a project; optional `only`, `base` (git ref), `files` and `min_severity` |
| `safegate_fix` | Gemini patches verified by re-scan; `apply: true` writes them. Needs `GEMINI_API_KEY` in the server's environment |
| `safegate_rules` | List the rules |

Build safegate once (`npm install && npm run build`), then register it. Use the absolute path to your copy; on Windows write it with forward slashes, e.g. `C:/Users/you/safegate/dist/src/cli.js`.

**Claude Code** (run inside your project):

```bash
claude mcp add safegate -e GEMINI_API_KEY=your-key -- node /path/to/safegate/dist/src/cli.js mcp
```

**Gemini CLI** (`~/.gemini/settings.json`), **Cursor** (`.cursor/mcp.json`), **Claude Desktop** (`claude_desktop_config.json`) and most other clients use the same JSON:

```json
{
  "mcpServers": {
    "safegate": {
      "command": "node",
      "args": ["/path/to/safegate/dist/src/cli.js", "mcp"],
      "env": { "GEMINI_API_KEY": "your-key" }
    }
  }
}
```

Leave out `env` if you only want scanning. Then ask the assistant, for example: "Run safegate on this project and fix the high findings." Clients that start the server outside your project (such as Claude Desktop) need the folder: "Scan C:/code/my-app with safegate."

## Private repositories

| Option | Where it runs | Best for |
|---|---|---|
| GitHub Action ([`docs/example-workflow.yml`](docs/example-workflow.yml)) | Your own GitHub runner | Every pull request, as a required check |
| MCP connector | The developer's machine | Checking code while an AI assistant writes it |
| CLI (`safegate check`, `safegate fix`) | The developer's machine or any CI | Local checks, GitLab, Bitbucket, Jenkins |
| Web page | Google Cloud Run | Public repositories only, by design |

In every option, `check` sends nothing anywhere. `fix` sends only the affected file and the schema to Gemini, using your own key.

## Web service (Cloud Run)

`safegate serve` starts a page where anyone can paste a public GitHub repository, see findings, and request verified fixes. It includes two demo apps: Next.js + Prisma (17 planted bugs) and tRPC + Drizzle + Hono (9 planted bugs). Deploy it with one script: see [`docs/DEPLOY-STEPS.md`](docs/DEPLOY-STEPS.md).

## Commands

| Command | What it does |
|---|---|
| `safegate check` | Scan the project |
| `safegate check --base origin/main` | Only report findings in files changed since `origin/main` (use in PRs) |
| `safegate check --only auth` / `--only migrations` | Run one checker |
| `safegate check --format text\|json\|sarif\|github\|markdown` | Output format (`github` = inline PR annotations) |
| `safegate check --fail-on high\|medium\|low\|none` | Exit code 1 when findings at/above this level exist (default `high`) |
| `safegate fix` | Gemini patches, verified by re-scan (see above) |
| `safegate serve` | Start the web service |
| `safegate mcp` | Run as an MCP server for AI assistants |
| `safegate rules` | List every rule |
| `safegate init` | Write a starter `safegate.config.json` |

Exit codes: `0` clean, `1` findings, `2` usage/runtime error.

## Rules

### Auth (TypeScript/JavaScript)

| Rule | Severity | Catches |
|---|---|---|
| AUTH001 | high (write) / medium (read) | An endpoint (route handler, server action, tRPC procedure, Express-style route, NestJS controller, GraphQL resolver, Remix/SvelteKit/Nuxt/Astro route) that touches the database with no auth check |
| AUTH002 | high | Owned record loaded by id without an owner filter or ownership comparison (IDOR); a list with no filter on an owned table |
| AUTH003 | high | Update or delete on an owned table not scoped to the owner, and no owner-scoped lookup before it |
| AUTH004 | medium / high | Request input (`body`, `await req.json()`, server-action params, `...spread`) passed straight into a write (Prisma `data`, Drizzle `.set()`, `repo.save(body)`, `Model.create(body)`, `new Model(body)`, Mongoose `$set`, Knex `.insert()` / `.update()`). High if the table has sensitive fields such as `role`. tRPC `.input(schema)`, NestJS DTO parameters and TanStack `.validator()` count as validated |
| AUTH005 | high | Admin endpoint or admin tRPC router that checks login but never checks role/permissions |

Auth is recognised from calls (`auth()`, `getServerSession()`, `currentUser()`, `supabase.auth.getUser()` ...), wrappers (`withAuth(handler)`), middleware (`requireAuth`, `passport.authenticate` ...), `app.use(auth)` including path-scoped `app.use("/api/*", auth)`, Fastify `preHandler` and Elysia `beforeHandle` options, tRPC procedures named like `protectedProcedure` or using `.use(isAuthed)`, Next.js `middleware.ts` / `proxy.ts` with a `matcher`, NestJS `@UseGuards(...)`, `@Auth()`, `@Roles()` and global guards, GraphQL `context.user`, Pothos `authScopes` and graphql-shield, SvelteKit `locals.user` and `hooks.server` redirects, Nuxt `requireUserSession`, Remix `requireUserId`, and the user read from the request (`req.user`, `ctx.state.user`, `c.get("user")`).

### Migrations (Postgres: SQL and code migrations)

| Rule | Severity | Catches |
|---|---|---|
| MIG001 | high | `CREATE INDEX` without `CONCURRENTLY` on an existing table (blocks writes) |
| MIG002 | high | `SET NOT NULL` (full scan under ACCESS EXCLUSIVE lock) |
| MIG003 | high | `ADD COLUMN ... NOT NULL` without `DEFAULT` (fails on non-empty tables) |
| MIG004 | medium | Volatile default such as `gen_random_uuid()` (table rewrite) |
| MIG005 | high | Column type change (table rewrite) |
| MIG006 | medium | `FOREIGN KEY` / `CHECK` without `NOT VALID` |
| MIG007 | high | `ADD CONSTRAINT UNIQUE/PRIMARY KEY` without `USING INDEX` |
| MIG008 | medium | `RENAME COLUMN` / `RENAME TO` (breaks old instances during rollout) |
| MIG009 | high | `DROP COLUMN` + `ADD COLUMN` on one table in one migration: Prisma's lossy "rename" |
| MIG010 | medium | `DROP COLUMN` / `DROP TABLE` |
| MIG011 | low | `DROP INDEX` without `CONCURRENTLY` |
| XCHK001 | high | Dropped column still used in code, or still declared in the schema or ORM model |

Changes to tables created in the same migration are never flagged (no rows yet). With `--base`, tables created anywhere in the PR count as new.

Code migrations map onto the same rules, with the fix written for that tool: for example `add_index` without `algorithm: :concurrently` (Rails), `AddIndex` instead of `AddIndexConcurrently` (Django), `op.create_index` without `postgresql_concurrently=True` (Alembic), `$table->index()` (Laravel), `queryInterface.addIndex` without `concurrently: true` (Sequelize). Rails `safety_assured { ... }` is respected.

## Configuration: `safegate.config.json`

Arrays **extend** the defaults (add `"replace": true` to replace them instead).

```json
{
  "ownerFields": ["projectId"],
  "authFunctions": ["getKindeServerSession", "requireMember"],
  "authWrappers": ["withWorkspace"],
  "publicRoutes": ["**/api/og/**", "app/api/public/**"],
  "prismaClientNames": ["prismaEdge"],
  "sensitiveFields": ["tier"],
  "schemaPath": "packages/db/prisma/schema.prisma",
  "migrationsDir": "packages/db/prisma/migrations",
  "disabledRules": ["MIG011"]
}
```

All options and defaults are in [`src/config.ts`](src/config.ts).

## Suppressing a finding (after review)

```ts
// safegate-ignore AUTH002 share links are readable by any signed-in user
const post = await prisma.post.findUnique({ where: { id } });
```
```sql
-- safegate-ignore MIG001 table has < 1000 rows
CREATE INDEX "Tag_name_idx" ON "Tag"("name");
```

The comment goes on the same line or the line above. Always write the reason.

## GitHub Actions

See [`docs/example-workflow.yml`](docs/example-workflow.yml). Findings appear as inline annotations on the PR diff, and high-severity findings fail the check.

## Known limitations (v0.4)

- Heuristic static analysis: it follows names, same-file helpers and one step from a NestJS controller into its services, not full cross-file data flow. If your auth helper has an unusual name, add it to `authFunctions`.
- Ownership is inferred from field names and references to User/Account/Organization-like models. Models owned through a parent (e.g. `Comment → Post → User`) are only covered if they have their own owner field. Add custom ones via `ownerFields`.
- Global auth layers are detected coarsely: a SvelteKit `hooks.server` or Nuxt server middleware that redirects anonymous users protects every route (or the path prefixes it checks with `startsWith`), and a NestJS global guard or graphql-shield protects everything not marked public.
- Editing a migration that has already been applied changes its checksum in Prisma. Use migration fixes on migrations that have not shipped yet (the pull-request stage).
- Verified Gemini fixes cover TypeScript/JavaScript and SQL files. Rails, Django, Alembic and Laravel migrations get the manual fix text only.
- Drizzle Kit lists migrations in `meta/_journal.json`, so fixes that need a new migration (MIG001, MIG002, MIG006, MIG007, MIG011) are not automated there: create it with `npx drizzle-kit generate --custom`.
- XCHK001 searches TypeScript/JavaScript code for the dropped column; Python, Ruby and PHP code is not searched.
- Lock severity does not yet consider table size. A `CREATE INDEX` on a 50-row table is flagged like one on 50M rows: suppress with a reason.

## Development

```bash
npm test                                   # build + 93 unit/e2e tests (Gemini is replaced by a local stand-in)
npm run demo                               # scan the Prisma demo app (17 planted bugs)
node dist/src/cli.js check --root examples/demo-t3 --fail-on none   # tRPC + Drizzle + Hono demo (9 planted bugs)
DATABASE_URL=... ./scripts/prove-migration-risks.sh   # prove lock/data-loss behaviour on real Postgres
```

See [VALIDATION.md](VALIDATION.md) for the full end-to-end validation plan, [docs/DEPLOY.md](docs/DEPLOY.md) for Google Cloud, and [docs/HACKATHON.md](docs/HACKATHON.md) for the business model and pitch.

MIT licensed.
