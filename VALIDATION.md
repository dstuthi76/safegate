# Validating safegate end to end

Each stage answers one question. Don't move to the next stage until the current one passes.

| Stage | Question | Time | Pass criteria |
|---|---|---|---|
| 1 | Does it build, and do the rules behave as designed? | 5 min | 50/50 tests pass |
| 2 | Does it find planted bugs without flagging safe code? | 5 min | Exactly 17 findings on the demo app |
| 3 | Are the migration risks real, and do the fixes work? | 10 min | 9/9 checks pass on real Postgres |
| 4 | Does PR mode only report what a PR changed? | 10 min | Only the new bug is reported; exit code 1 |
| 5 | Does it work inside GitHub? | 30 min | Inline annotations on a PR; check fails |
| 6 | Is it accurate on real code? (precision) | 1–2 weekends | ≥ 80% precision on high-severity findings |
| 7 | Does it catch bugs it has never seen? (recall) | 1 evening | ≥ 80% of injected bugs caught |
| 8 | Is it fast enough for CI? | 15 min | < 30 s on a large repo |
| 9 | Do developers want it? | 2–3 weeks | See the user metrics in stage 9 |
| 10 | Do Gemini fixes and the Google Cloud deployment work for real? | 1 hour | Live verified fix; live URL passes the 4 checks |

---

## Stage 1: Build and unit tests

```bash
cd safegate
npm install
npm test
```

Expected tail of the output:

```
# tests 50
# pass 50
# fail 0
```

What these cover:
- `test/sql.test.ts`: SQL statement splitting (strings, comments, `$$` bodies), Prisma schema parsing (owner fields, relations, `@map`/`@@map`).
- `test/migrations.test.ts`: every MIG rule with a **bad** case that must fire and a **safe** case that must stay quiet, plus line numbers, suppression comments and the code cross-check.
- `test/auth.test.ts`: every AUTH rule with bad and safe variants: same-file auth helpers, `withAuth()` wrappers, Next.js middleware matchers, Express middleware and `router.use()`, ownership checks before and after the query.
- `test/ai.test.ts`: the Gemini client (request shape, retries, model fallback, Vertex AI mode), the verify loop (wrong, cheating and syntax-breaking patches rejected; correct patch accepted), and the web service (demo scan, fix, GitHub download with hostile archive contents). Gemini is replaced by a local stand-in server, so these tests need no key.
- `test/e2e.test.ts`: the demo app (stage 2), CLI exit codes, JSON/SARIF/GitHub output.

**If a test fails:** the test name says which rule and which variant. Fix the rule, not the test, unless the test expectation is wrong.

## Stage 2: The demo app (planted bugs)

```bash
npm run demo
```

Expected: **17 findings (13 high, 4 medium)**. Each one is marked `PLANTED` in a comment in the source:

| Finding | File | Bug |
|---|---|---|
| AUTH001 | `app/actions/posts.ts` | `deletePost` server action has no auth |
| AUTH001 | `server/express.ts` | `POST /posts` has no auth middleware |
| AUTH002 | `app/api/posts/[id]/route.ts` | GET reads any post by id |
| AUTH002 | `server/express.ts` | `GET /invoices/:id` reads any invoice |
| AUTH003 | `app/api/posts/[id]/route.ts` | DELETE deletes any post |
| AUTH004 | `app/api/posts/[id]/route.ts` | `data: body` |
| AUTH004 | `app/actions/posts.ts` | `updateProfile(data)` lets the caller set `role` |
| AUTH005 | `app/api/admin/users/route.ts` | no role check |
| MIG001, MIG003 | `20240201000000_add_slug` | blocking index, required column without default |
| MIG009 | `20240301000000_rename_bio` | Prisma's lossy rename |
| MIG002, MIG004, MIG005, MIG006 | `20240401000000_tighten` | lock-heavy changes |
| MIG010, XCHK001 | `20240501000000_drop_legacy` | drop while `lib/legacy.ts` still queries it |

Equally important, these **safe** files must produce **no** findings: `app/api/posts/route.ts`, `app/api/invoices/[id]/route.ts` (ownership check after load, owned lookup before delete), `app/api/admin/stats/route.ts` (role check), `app/api/webhooks/stripe/route.ts` (public by config), `app/api/blog/[slug]/route.ts` (`published: true`), `app/api/share/[id]/route.ts` (reviewed `safegate-ignore`), `publishPost` in `app/actions/posts.ts`, `GET /my/invoices` in Express, and migrations `20240101000000_init` (new tables) and `20240601000000_safe_index` (`CONCURRENTLY`).

The e2e test enforces this exact list, so any new false positive or missed bug fails `npm test`.

## Stage 3: Prove the migration risks on real Postgres

This checks the claims behind the rules, not just the code.

```bash
# any throwaway Postgres 12+; Docker is easiest:
docker run -d --name sg-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres ./scripts/prove-migration-risks.sh
```

Expected (verified on PostgreSQL 16.15, 300,000 rows):

```
MIG001  PASS  INSERT was blocked while the index was being built
        PASS  with CONCURRENTLY, INSERT succeeded during the build
MIG002  PASS  even SELECT was blocked (ACCESS EXCLUSIVE lock)
        PASS  with NOT VALID + VALIDATE, writes continued during validation
MIG003  PASS  migration failed: this deploy would break
        PASS  with a constant DEFAULT it succeeds
MIG006  PASS  INSERT was blocked while the foreign key was validated
MIG009  PASS  300000 values existed before, 0 remain after the migration
        PASS  with RENAME COLUMN all 300000 values are kept
Result: 9 passed, 0 failed
```

The script holds each migration open for 3 seconds, like a slow migration on a big table, while a second connection tries to read or write with a 1-second `lock_timeout`. It never touches anything outside the `safegate_proof` schema. Still, **never point it at production**.

Optional: check that the demo migrations are valid SQL by applying them to an empty database in order (`psql -f` each `migration.sql`). All six should apply.

## Stage 4: PR mode (only report what changed)

```bash
cp -r examples/demo-app /tmp/pr-sim && cd /tmp/pr-sim
git init -q -b main && git add -A && git commit -qm base && git checkout -qb feature

mkdir -p prisma/migrations/20240701000000_new
echo 'CREATE INDEX "Invoice_amount_idx" ON "Invoice"("amount");' > prisma/migrations/20240701000000_new/migration.sql
mkdir -p app/api/tags
printf 'import { prisma } from "@/lib/db";\nexport async function POST() {\n  await prisma.post.deleteMany({ where: { published: false } });\n}\n' > app/api/tags/route.ts
git add -A && git commit -qm feature

node /path/to/safegate/dist/src/cli.js check --base main; echo "exit=$?"
```

Expected: exactly **2 findings** (MIG001 in the new migration, AUTH001 in the new route), none of the 17 old ones, and `exit=1`. Then fix both, commit, and re-run: expect `No findings.` and `exit=0`.

## Stage 5: GitHub integration

1. Push safegate to a GitHub repo of yours and tag it: `git tag v0.1.0 && git push --tags`.
2. Create a second repo from `examples/demo-app`. Copy `docs/example-workflow.yml` to `.github/workflows/safegate.yml` and replace `your-github-user/safegate@v0.1.0` with your repo and tag.
3. Open a PR that adds one bug (e.g. the `app/api/tags/route.ts` from stage 4).
4. Check:
   - [ ] The `safegate` check runs and **fails**.
   - [ ] The finding appears as an **inline annotation** on the changed line in "Files changed".
   - [ ] Old bugs that the PR didn't touch are **not** reported.
   - [ ] After fixing the bug and pushing, the check **passes**.
   - [ ] (Optional SARIF job) findings appear under **Security → Code scanning**.
5. In branch protection, make `safegate` a required check.

## Stage 6: Precision on real repositories

This is the most important stage. **A security tool that cries wolf gets uninstalled.**

1. Pick 5–10 open-source apps that use **Next.js or Express with Prisma**. Try ones like Documenso, Formbricks, Dub, Umami or cal.com, but confirm each still uses Prisma before you start. In monorepos, point `--root` at the package that has `prisma/`, or set `schemaPath`/`migrationsDir` in a config.
2. For each repo:
   ```bash
   node dist/src/cli.js check --root ../repo --format json --fail-on none > repo.json
   node scripts/precision.mjs to-csv repo.json repo >> labels.csv
   ```
3. Open `labels.csv` and label **every** finding `TP` or `FP` by reading the code. TP means a real bug or a real risk a reviewer would want flagged. Write a short note on each FP saying why it's wrong (e.g. "auth helper named `getTeamOrThrow`", "Comment owned via Post").
4. Score:
   ```bash
   node scripts/precision.mjs score labels.csv
   ```
5. **Targets:** high-severity precision ≥ 80% overall, and no single rule below 60%.
6. For every FP pattern, either:
   - **Fix the rule** and add the FP as a safe case in `test/auth.test.ts` or `test/migrations.test.ts`. This becomes your regression suite, or
   - **Make it configurable** (e.g. add the helper name to `authFunctions`) and document it in the README.
7. Re-run steps 2–4 until you hit the targets.

> Real bugs you find here are your best launch material. Report security issues privately to the maintainers (check their `SECURITY.md`). Never open public issues for security bugs.

## Stage 7: Recall (does it catch bugs it hasn't seen?)

Precision alone can be gamed by flagging nothing. Measure recall with **mutation testing**: inject realistic bugs into safe code and count how many are caught.

Take 20 safe handlers from the stage 6 repos (or the demo's safe files) and apply one mutation each:

| Mutation | Example | Should trigger |
|---|---|---|
| Remove the owner filter | `where: { id, userId: session.user.id }` → `where: { id }` | AUTH002 / AUTH003 |
| Remove the auth call | delete the `const session = await auth()` block | AUTH001 |
| Remove the ownership comparison | delete `if (doc.userId !== session.user.id) ...` | AUTH002 |
| Pass the body through | `data: { title: body.title }` → `data: body` | AUTH004 |
| Remove the role check | delete `if (session.user.role !== "ADMIN")` in an admin route | AUTH005 |
| Make an index blocking | `CREATE INDEX CONCURRENTLY` → `CREATE INDEX` | MIG001 |
| Rename via schema.prisma | rename a field, run `prisma migrate dev --create-only` | MIG009 |

**Target:** ≥ 80% of mutations caught. Each miss is either a new test case plus a rule improvement, or a documented limitation.

## Stage 8: Performance

```bash
time node dist/src/cli.js check --root ../large-repo --fail-on none > /dev/null
```

**Target:** under 30 seconds on a repo with ~5,000 source files. (Measured during development: 2.8 s for a synthetic repo with 5,000 route files and 15,000 endpoints.) (PR mode with `--base` is much faster since it parses only changed files). If it's slow, check that `ignore` excludes generated folders (`.next`, `dist`, generated Prisma clients).

## Stage 9: Developer validation

Code that works isn't the same as a product people want. With the tool working:

1. Get it running on **10 real teams' repos** (friends, your workplace with permission, Discord/Reddit communities for Next.js and Prisma).
2. Track for 2–3 weeks:
   - **Activation:** the tool ran in CI on ≥ 3 PRs.
   - **True-positive rate as judged by them:** ask "was this finding useful?" on every finding.
   - **Retention:** still enabled after 2 weeks? (Disabling = your FP rate is too high.)
   - **The money question:** "Would you pay $X/month for a hosted version with a dashboard and org-wide policies?"
3. **Signals to keep going:** ≥ 5 of 10 teams keep it on, and at least one real bug was caught before merge.

## Stage 10: Gemini and Google Cloud, for real

The automated tests replace Gemini with a stand-in. This stage checks the real thing.

**A. Real Gemini from your laptop (10 minutes)**

```bash
export GEMINI_API_KEY=your-key        # https://aistudio.google.com/apikey
node dist/src/cli.js fix --root examples/demo-app
```

Expected: 15 fixable findings attempted (the first 10 by default; add `--max 20` for all), most marked `VERIFIED` with a small diff. Record three numbers for your pitch:

- **Acceptance rate** = verified ÷ attempted. Target ≥ 70% on the demo app.
- **Average attempts** per verified fix (1 is ideal, 3 is the limit).
- **Cost per fix** from the usage page in Google AI Studio.

Then read every verified diff. For each, ask: would I merge this? A verified patch that you would not merge (for example it changes behaviour beyond the fix) is a case to add to the prompt rules in `src/ai/fix.ts`.

If you see `Model ... was not found`, set `SAFEGATE_GEMINI_MODEL` to a model listed at <https://aistudio.google.com/docs/models>.

**B. Apply and re-check**

```bash
cp -r examples/demo-app /tmp/demo-fixed
node dist/src/cli.js fix --root /tmp/demo-fixed --max 20 --apply
node dist/src/cli.js check --root /tmp/demo-fixed --fail-on none
```

Expected: the finding count drops from 17 to roughly the number of non-fixable or rejected findings, and `git diff`-style inspection of `/tmp/demo-fixed` shows only small, targeted edits.

**C. Cloud Run** Follow `docs/DEPLOY.md` sections 2 and 3. All four checks in section 3 must pass on the live URL.

**D. GitHub Action with fixes** Add the `GEMINI_API_KEY` repository secret and the workflow from `docs/example-workflow.yml`, open a PR with a planted bug, and expect a PR comment titled "safegate: N verified fixes from Gemini".

## Exit checklist before a public launch

- [ ] Stages 1–5 pass
- [ ] Precision ≥ 80% on high severity across ≥ 5 real repos (stage 6)
- [ ] Recall ≥ 80% on ≥ 20 mutations (stage 7)
- [ ] Every FP you found is now a regression test
- [ ] README lists the known limitations honestly
- [ ] A short demo GIF of PR annotations
- [ ] One write-up of a real bug class it catches (anonymized), for the launch post
