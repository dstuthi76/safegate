import { Finding, RuleMeta, Severity } from "../types";
import { IDENT, SqlStatement, unquoteIdent } from "./sql";

export const MIGRATION_RULES: RuleMeta[] = [
  { id: "MIG001", name: "index-not-concurrent", severity: "high", description: "CREATE INDEX without CONCURRENTLY blocks all writes to the table while the index builds." },
  { id: "MIG002", name: "set-not-null", severity: "high", description: "SET NOT NULL scans the whole table under an ACCESS EXCLUSIVE lock (blocks reads and writes)." },
  { id: "MIG003", name: "required-column-without-default", severity: "high", description: "Adding a NOT NULL column without a DEFAULT fails on any table that already has rows." },
  { id: "MIG004", name: "volatile-default", severity: "medium", description: "A volatile DEFAULT (e.g. gen_random_uuid()) forces a full table rewrite under ACCESS EXCLUSIVE lock." },
  { id: "MIG005", name: "column-type-change", severity: "high", description: "Changing a column type usually rewrites the table under ACCESS EXCLUSIVE lock." },
  { id: "MIG006", name: "constraint-without-not-valid", severity: "medium", description: "Adding a FOREIGN KEY or CHECK constraint without NOT VALID validates every row while holding a lock." },
  { id: "MIG007", name: "unique-constraint-builds-index", severity: "high", description: "ADD CONSTRAINT UNIQUE/PRIMARY KEY builds an index while holding an ACCESS EXCLUSIVE lock." },
  { id: "MIG008", name: "rename", severity: "medium", description: "Renaming a column or table breaks application instances still running the old code during deploy." },
  { id: "MIG009", name: "drop-and-add-likely-rename", severity: "high", description: "A column is dropped and another added on the same table: often a rename that Prisma turned into DROP + ADD, losing the data." },
  { id: "MIG010", name: "destructive-drop", severity: "medium", description: "Dropping a column or table is irreversible and breaks code that still reads it during rollout." },
  { id: "MIG011", name: "drop-index-not-concurrent", severity: "low", description: "DROP INDEX without CONCURRENTLY takes an ACCESS EXCLUSIVE lock on the table." }
];

const META = new Map(MIGRATION_RULES.map((r) => [r.id, r]));

export interface MigrationContext {
  file: string;
  /** Tables created earlier in the same unit of analysis: changes to them are safe (no existing rows). */
  newTables: Set<string>;
}

/** Info about dropped columns, used by the cross-check against application code. */
export interface DroppedColumn {
  table: string;
  column: string;
  file: string;
  line: number;
}

export interface MigrationAnalysis {
  findings: Finding[];
  droppedColumns: DroppedColumn[];
}

const VOLATILE_FUNCS = /\b(gen_random_uuid|uuid_generate_v[14]|random|clock_timestamp|timeofday|nextval)\s*\(/i;

/** Splits on commas that are not nested in parentheses or quotes. */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function lineFor(stmt: SqlStatement, needle: string): number {
  const idx = stmt.raw.indexOf(needle);
  if (idx < 0) return stmt.line;
  return stmt.line + (stmt.raw.slice(0, idx).match(/\n/g) || []).length;
}

function make(ruleId: string, ctx: MigrationContext, line: number, message: string, fix: string, severity?: Severity): Finding {
  const meta = META.get(ruleId)!;
  return { ruleId, severity: severity ?? meta.severity, title: meta.description, message, fix, file: ctx.file, line };
}

/** Analyzes the statements of one migration file. */
export function analyzeStatements(statements: SqlStatement[], ctx: MigrationContext): MigrationAnalysis {
  const findings: Finding[] = [];
  const droppedColumns: DroppedColumn[] = [];
  const dropsByTable = new Map<string, { column: string; line: number }[]>();
  const addsByTable = new Map<string, string[]>();

  for (const stmt of statements) {
    const s = stmt.text;

    // CREATE TABLE
    let m = new RegExp(`^CREATE\\s+(?:UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})`, "i").exec(s);
    if (m) {
      ctx.newTables.add(unquoteIdent(m[1]));
      continue;
    }

    // CREATE INDEX
    m = new RegExp(`^CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:(${IDENT})\\s+)?ON\\s+(?:ONLY\\s+)?(${IDENT})`, "i").exec(s);
    if (m) {
      const table = unquoteIdent(m[4]);
      if (!m[2] && !ctx.newTables.has(table)) {
        const name = m[3] ? unquoteIdent(m[3]) : "(unnamed)";
        findings.push(
          make(
            "MIG001",
            ctx,
            stmt.line,
            `Index ${name} on existing table "${table}" is built without CONCURRENTLY, so INSERT/UPDATE/DELETE on "${table}" wait until it finishes.`,
            `Move this statement into its own migration and write it as CREATE ${m[1] ? "UNIQUE " : ""}INDEX CONCURRENTLY ... (CONCURRENTLY cannot run inside a transaction block, so it must be the only statement in that migration).`
          )
        );
      }
      continue;
    }

    // DROP INDEX
    m = /^DROP\s+INDEX\s+(CONCURRENTLY\s+)?/i.exec(s);
    if (m) {
      if (!m[1]) {
        findings.push(make("MIG011", ctx, stmt.line, "DROP INDEX without CONCURRENTLY locks the table against reads and writes until the drop completes.", "Use DROP INDEX CONCURRENTLY in a migration of its own."));
      }
      continue;
    }

    // DROP TABLE
    m = new RegExp(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT}(?:\\s*,\\s*${IDENT})*)`, "i").exec(s);
    if (m) {
      for (const t of splitTopLevel(m[1]).map(unquoteIdent)) {
        if (ctx.newTables.has(t)) continue;
        findings.push(make("MIG010", ctx, stmt.line, `Table "${t}" is dropped. Its data is gone permanently, and any running code that queries it will error.`, "Remove all code that uses this table in an earlier deploy, take a backup, then drop the table in a later release (expand/contract)."));
      }
      continue;
    }

    // ALTER TABLE ... RENAME TO
    m = new RegExp(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${IDENT})\\s+RENAME\\s+TO\\s+(${IDENT})`, "i").exec(s);
    if (m) {
      const from = unquoteIdent(m[1]);
      findings.push(make("MIG008", ctx, stmt.line, `Table "${from}" is renamed to "${unquoteIdent(m[2])}". App instances still running the previous release will query the old name and fail.`, "Use expand/contract: create the new table or a view with the new name, deploy code that uses it, then remove the old name in a later release."));
      continue;
    }

    // ALTER TABLE <t> <actions>
    m = new RegExp(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${IDENT})\\s+(.*)$`, "i").exec(s);
    if (!m) continue;
    const table = unquoteIdent(m[1]);
    const isNew = ctx.newTables.has(table);
    const actions = splitTopLevel(m[2]);

    for (const action of actions) {
      let a: RegExpExecArray | null;

      // RENAME COLUMN
      if ((a = new RegExp(`^RENAME\\s+(?:COLUMN\\s+)?(${IDENT})\\s+TO\\s+(${IDENT})`, "i").exec(action))) {
        const col = unquoteIdent(a[1]);
        findings.push(make("MIG008", ctx, lineFor(stmt, col), `Column "${table}"."${col}" is renamed to "${unquoteIdent(a[2])}". Instances running the previous release still use "${col}" and will fail during rollout.`, "Use expand/contract: add the new column, write to both, backfill, switch reads, and drop the old column in a later release."));
        continue;
      }

      // ADD COLUMN
      if ((a = new RegExp(`^ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})\\s+(.*)$`, "i").exec(action)) && !/^ADD\s+(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)\b/i.test(action)) {
        const col = unquoteIdent(a[1]);
        const def = a[2];
        if (!addsByTable.has(table)) addsByTable.set(table, []);
        addsByTable.get(table)!.push(col);
        if (isNew) continue;
        const notNull = /\bNOT\s+NULL\b/i.test(def);
        const hasDefault = /\bDEFAULT\b/i.test(def);
        const generated = /\bGENERATED\b/i.test(def);
        if (notNull && !hasDefault && !generated) {
          findings.push(make("MIG003", ctx, lineFor(stmt, col), `Column "${table}"."${col}" is NOT NULL with no DEFAULT. If "${table}" has any rows, this migration fails at deploy time.`, `Add the column as nullable, backfill existing rows, then add NOT NULL in a later migration, or give it a constant DEFAULT (e.g. DEFAULT '').`));
        }
        if (hasDefault && VOLATILE_FUNCS.test(def)) {
          findings.push(make("MIG004", ctx, lineFor(stmt, col), `Column "${table}"."${col}" uses a volatile DEFAULT, so Postgres rewrites every row of "${table}" while blocking reads and writes.`, "Add the column without the default, set the default for new rows only (ALTER COLUMN ... SET DEFAULT ...), and backfill existing rows in batches."));
        }
        continue;
      }

      // DROP COLUMN
      if ((a = new RegExp(`^DROP\\s+(?:COLUMN\\s+)?(?:IF\\s+EXISTS\\s+)?(${IDENT})`, "i").exec(action)) && !/^DROP\s+(CONSTRAINT|DEFAULT|NOT\s+NULL)\b/i.test(action)) {
        const col = unquoteIdent(a[1]);
        const line = lineFor(stmt, col);
        if (!dropsByTable.has(table)) dropsByTable.set(table, []);
        dropsByTable.get(table)!.push({ column: col, line });
        if (!isNew) droppedColumns.push({ table, column: col, file: ctx.file, line });
        continue;
      }

      // ALTER COLUMN ...
      if ((a = new RegExp(`^ALTER\\s+(?:COLUMN\\s+)?(${IDENT})\\s+(.*)$`, "i").exec(action))) {
        if (isNew) continue;
        const col = unquoteIdent(a[1]);
        const op = a[2];
        if (/^SET\s+NOT\s+NULL/i.test(op)) {
          findings.push(make("MIG002", ctx, lineFor(stmt, col), `SET NOT NULL on "${table}"."${col}" scans every row while holding an ACCESS EXCLUSIVE lock: all reads and writes to "${table}" wait.`, `On Postgres 12+: ADD CONSTRAINT ${col}_not_null CHECK ("${col}" IS NOT NULL) NOT VALID; then VALIDATE CONSTRAINT in a separate migration; then SET NOT NULL (now instant) and drop the check.`));
        } else if (/^(SET\s+DATA\s+)?TYPE\b/i.test(op)) {
          findings.push(make("MIG005", ctx, lineFor(stmt, col), `Type change on "${table}"."${col}" (${op.replace(/\s+USING.*$/i, "")}) usually rewrites the whole table under an ACCESS EXCLUSIVE lock.`, "Add a new column with the new type, backfill in batches, switch the code over, then drop the old column. (Only safe in place for binary-compatible changes like increasing a VARCHAR limit.)"));
        }
        continue;
      }

      // ADD CONSTRAINT
      if ((a = /^ADD\s+(?:CONSTRAINT\s+("?[^"\s]+"?)\s+)?(FOREIGN\s+KEY|CHECK|UNIQUE|PRIMARY\s+KEY)\b(.*)$/i.exec(action))) {
        if (isNew) continue;
        const kind = a[2].toUpperCase().replace(/\s+/g, " ");
        const rest = a[3];
        const name = a[1] ? unquoteIdent(a[1]) : kind;
        if ((kind === "FOREIGN KEY" || kind === "CHECK") && !/\bNOT\s+VALID\b/i.test(rest)) {
          findings.push(make("MIG006", ctx, lineFor(stmt, a[1] ? a[1] : kind), `${kind} constraint ${name} on existing table "${table}" is validated against every row while holding a lock that blocks writes.`, `Add it with NOT VALID in this migration, then run ALTER TABLE "${table}" VALIDATE CONSTRAINT ${a[1] ?? "<name>"}; in a separate migration (validation then does not block writes).`));
        }
        if ((kind === "UNIQUE" || kind === "PRIMARY KEY") && !/\bUSING\s+INDEX\b/i.test(rest)) {
          findings.push(make("MIG007", ctx, lineFor(stmt, a[1] ? a[1] : kind), `${kind} constraint ${name} on existing table "${table}" builds its index while holding an ACCESS EXCLUSIVE lock.`, `First CREATE UNIQUE INDEX CONCURRENTLY in its own migration, then ADD CONSTRAINT ${name} ${kind} USING INDEX <index_name>.`));
        }
        continue;
      }
    }
  }

  // Cross-statement: drop + add on the same table in one migration => probable rename (data loss)
  for (const [table, drops] of dropsByTable) {
    if (ctx.newTables.has(table)) continue;
    const adds = addsByTable.get(table) || [];
    for (const drop of drops) {
      if (adds.length) {
        findings.push(make("MIG009", ctx, drop.line, `"${table}"."${drop.column}" is dropped while ${adds.map((c) => `"${c}"`).join(", ")} ${adds.length > 1 ? "are" : "is"} added in the same migration. If this was meant as a rename, every existing value in "${drop.column}" is deleted.`, `If it is a rename, edit the migration to ALTER TABLE "${table}" RENAME COLUMN "${drop.column}" TO "${adds[0]}" (and use @map in schema.prisma), or copy the data before the drop.`));
      } else {
        findings.push(make("MIG010", ctx, drop.line, `Column "${table}"."${drop.column}" is dropped. The data is gone permanently, and app instances still running the previous release will fail when they read it.`, "Stop using the column in an earlier deploy, back up the data if needed, then drop it in a later release (expand/contract)."));
      }
    }
  }

  return { findings, droppedColumns };
}
