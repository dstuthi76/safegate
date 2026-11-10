---
name: safegate
description: Check Next.js or Express + Prisma code for access-control bugs and unsafe Postgres migrations before finishing a task. Use after writing or changing API routes, server actions, Prisma queries, schema.prisma or migration files.
---

# safegate

Run this check before you say a task is done, whenever you touched API routes, server actions, Prisma queries, `schema.prisma` or files under `prisma/migrations`.

## Steps

1. From the project root run:

   ```bash
   npx safegate check --format json --fail-on none
   ```

2. Read `findings`. Each has `ruleId`, `file`, `line`, `message` and `fix`.
3. Fix every `high` finding in code you wrote or changed, following its `fix` text:
   - `AUTH001`: get the session first and return 401 when there is none.
   - `AUTH002` / `AUTH003`: add the owner field (for example `userId: session.user.id`) to the Prisma `where`, or compare the owner field to the current user before returning or changing the record.
   - `AUTH004`: pass only named fields into `data`, never the request body.
   - `AUTH005`: check the user's role after authentication.
   - `MIG*`: rewrite the migration as the `fix` text describes. `CREATE INDEX CONCURRENTLY` goes in a migration of its own.
4. Run the check again. Repeat until your changes produce no `high` findings.
5. Do not add `safegate-ignore` comments unless the user confirms the behaviour is intended. If they do, write the reason in the comment.
6. In your summary, tell the user which findings you fixed and list any that remain.
