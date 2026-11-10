# safegate

**A pull-request safety gate for Next.js / Express + Prisma + Postgres apps.**
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
- **Schema-aware.** It reads `schema.prisma` to learn which models belong to a user (`userId`, `authorId`, `orgId`...). That is what keeps false positives low.
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

## Web service (Cloud Run)

`safegate serve` starts a page where anyone can paste a public GitHub repository, see findings, and request verified fixes. Deploy it with one script: see [`docs/DEPLOY.md`](docs/DEPLOY.md).

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
| `safegate rules` | List every rule |
| `safegate init` | Write a starter `safegate.config.json` |

Exit codes: `0` clean, `1` findings, `2` usage/runtime error.

## Rules

### Auth (TypeScript/JavaScript)

| Rule | Severity | Catches |
|---|---|---|
| AUTH001 | high (write) / medium (read) | Route handler, server action, `pages/api` or Express route that touches the database with no auth check |
| AUTH002 | high | Owned record loaded by id without an owner filter or ownership comparison (IDOR); `findMany()` with no `where` on an owned model |
| AUTH003 | high | `update`/`delete`/`updateMany`/`deleteMany` on an owned model not scoped to the owner, and no owner-scoped lookup before it |
| AUTH004 | medium / high | Request input (`body`, `await req.json()`, server-action params, `...spread`) passed straight into Prisma `data`. High if the model has sensitive fields such as `role` |
| AUTH005 | high | `/admin` endpoint that checks login but never checks role/permissions |

Entry points found automatically: App Router `route.ts` handlers (`GET`, `POST`, ...), `"use server"` files and inline server actions, `pages/api/*`, and Express `app|router.get/post/put/patch/delete("/path", ...)`.
Auth is recognised from calls (`auth()`, `getServerSession()`, `currentUser()`, `supabase.auth.getUser()` ...), wrappers (`withAuth(handler)`), Express middleware (`requireAuth`, `passport.authenticate` ...), `router.use(auth)`, and Next.js `middleware.ts` / `proxy.ts` with a `matcher`.

### Migrations (Postgres SQL in `prisma/migrations/*/migration.sql`)

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
| XCHK001 | high | Dropped column still used in code, or still declared in `schema.prisma` |

Changes to tables created in the same migration are never flagged (no rows yet). With `--base`, tables created anywhere in the PR count as new.

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

## Known limitations (v0.2)

- Heuristic static analysis: it follows names and same-file helpers, not full cross-file data flow. If your auth helper has an unusual name, add it to `authFunctions`.
- Ownership is inferred from field names. Models owned through a parent (e.g. `Comment → Post → User`) are only covered if they have their own owner field. Add custom ones via `ownerFields`.
- Editing a migration that has already been applied to a database changes its checksum in Prisma. Use migration fixes on migrations that have not shipped yet (the pull-request stage).
- Prisma + Postgres only. Not yet supported: Drizzle, TypeORM, tRPC procedures, GraphQL resolvers, MySQL.
- Lock severity does not yet consider table size. A `CREATE INDEX` on a 50-row table is flagged like one on 50M rows: suppress with a reason.

## Development

```bash
npm test                                   # build + 50 unit/e2e tests (Gemini is replaced by a local stand-in)
npm run demo                               # scan the demo app (17 planted bugs)
DATABASE_URL=... ./scripts/prove-migration-risks.sh   # prove lock/data-loss behaviour on real Postgres
```

See [VALIDATION.md](VALIDATION.md) for the full end-to-end validation plan, [docs/DEPLOY.md](docs/DEPLOY.md) for Google Cloud, and [docs/HACKATHON.md](docs/HACKATHON.md) for the business model and pitch.

MIT licensed.
