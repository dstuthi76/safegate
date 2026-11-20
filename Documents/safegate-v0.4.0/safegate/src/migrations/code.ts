import * as fs from "fs";
import * as path from "path";
import { PrismaField, PrismaModel } from "../prisma/schema";
import { Finding } from "../types";
import { lineOf, toPosix, walk } from "../util/files";
import { camel, isOwnerName } from "../orm/models";
import { analyzeStatements, DroppedColumn, MIGRATION_RULES } from "./rules";
import { splitSql } from "./sql";

/**
 * Migrations written as code. Each tool's schema operations are mapped onto the same MIG rules as SQL,
 * and raw SQL embedded in them (queryRunner.query, knex.raw, execute, RunSQL, op.execute, DB::statement,
 * pgm.sql) goes through the SQL analyzer. Only the "up" direction is read.
 */
export type MigrationTool = "rails" | "django" | "alembic" | "laravel" | "knex" | "sequelize" | "typeorm" | "node-pg-migrate";

export interface CodeMigration {
  abs: string;
  rel: string;
  tool: MigrationTool;
}

const TOOL_NAME: Record<MigrationTool, string> = {
  rails: "Rails",
  django: "Django",
  alembic: "Alembic",
  laravel: "Laravel",
  knex: "Knex",
  sequelize: "Sequelize",
  typeorm: "TypeORM",
  "node-pg-migrate": "node-pg-migrate"
};

const EXTRA_IGNORE = ["**/site-packages/**", "**/venv/**", "**/.venv/**", "vendor/**", "**/vendor/**", "**/*.d.ts"];

export function detectTool(rel: string, text: string): MigrationTool | null {
  if (/(^|\/)db\/migrate\/[^/]+\.rb$/.test(rel)) return "rails";
  if (rel.endsWith(".py")) {
    if (/(^|\/)migrations\/\d{4}_[\w]+\.py$/.test(rel) && /migrations\.Migration/.test(text)) return "django";
    if (/(^|\/)versions\/[^/]+\.py$/.test(rel) && /def upgrade\s*\(/.test(text)) return "alembic";
    return null;
  }
  if (rel.endsWith(".php")) return /(^|\/)database\/migrations\/[^/]+\.php$/.test(rel) ? "laravel" : null;
  if (!/(^|\/)migrations?\//i.test(rel)) return null;
  if (/MigrationInterface|queryRunner/.test(text)) return "typeorm";
  if (/queryInterface/.test(text)) return "sequelize";
  if (/\bpgm\.\w+\(/.test(text)) return "node-pg-migrate";
  if (/\.schema\.(createTable|alterTable|table|dropTable|renameTable|raw)\b|knex\.raw\(|exports\.up\s*=\s*(async\s*)?(function\s*)?\(?\s*knex/.test(text)) return "knex";
  return null;
}

export function findCodeMigrations(root: string, ignore: string[]): CodeMigration[] {
  const out: CodeMigration[] = [];
  for (const abs of walk(root, [".rb", ".py", ".php", ".js", ".ts", ".cjs", ".mjs"], [...ignore, ...EXTRA_IGNORE])) {
    const rel = toPosix(path.relative(root, abs));
    if (!/(^|\/)(db\/migrate|migrations?|versions|database\/migrations)\//i.test(rel)) continue;
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const tool = detectTool(rel, text);
    if (tool) out.push({ abs, rel, tool });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Blanks [from, to) while keeping line breaks, so line numbers stay right. */
function blank(text: string, from: number, to: number): string {
  return text.slice(0, from) + text.slice(from, to).replace(/[^\n]/g, " ") + text.slice(to);
}

const DOWN: Record<MigrationTool, { down: RegExp; up: RegExp } | null> = {
  rails: { down: /^[ \t]*def[ \t]+down\b/m, up: /^[ \t]*def[ \t]+(up|change)\b/m },
  alembic: { down: /^def[ \t]+downgrade\s*\(/m, up: /^def[ \t]+upgrade\s*\(/m },
  laravel: { down: /public\s+function\s+down\s*\(/, up: /public\s+function\s+up\s*\(/ },
  django: null,
  knex: null,
  sequelize: null,
  typeorm: null,
  "node-pg-migrate": null
};
const JS_DOWN = /(exports\.down\b|export\s+(async\s+)?function\s+down\b|export\s+const\s+down\b|\basync\s+down\s*\(|\bdown\s*:\s*(async\s*)?(\(|function)|^\s*(public\s+)?down\s*\()/m;
const JS_UP = /(exports\.up\b|export\s+(async\s+)?function\s+up\b|export\s+const\s+up\b|\basync\s+up\s*\(|\bup\s*:\s*(async\s*)?(\(|function)|^\s*(public\s+)?up\s*\()/m;

/** The part of the file that runs on deploy. */
export function upSection(tool: MigrationTool, text: string): string {
  const m = DOWN[tool] ?? (tool === "django" ? null : { down: JS_DOWN, up: JS_UP });
  if (!m) return text;
  const d = m.down.exec(text);
  if (!d) return text;
  const u = m.up.exec(text);
  return !u || u.index < d.index ? blank(text, d.index, text.length) : blank(text, d.index, u.index);
}

/** Text between the parenthesis at `open` and its match, skipping strings. */
export function argsAt(text: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

/** String literal (and Ruby symbol) values, in order. */
function strings(s: string): string[] {
  const out: string[] = [];
  const re = /(['"`])((?:\\.|(?!\1)[^\\])*)\1|(?<![\w:]):(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[2] ?? m[3]);
  return out;
}

/** Splits on ";" at depth 0 (statements inside a Laravel or Knex block). */
function statements(body: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ";" && depth === 0) {
      out.push({ text: body.slice(start, i), offset: start });
      start = i + 1;
    }
  }
  if (body.slice(start).trim()) out.push({ text: body.slice(start), offset: start });
  return out;
}

const RAW_SQL: Record<MigrationTool, RegExp> = {
  typeorm: /queryRunner\.query\s*\(\s*/g,
  knex: /\.raw\s*\(\s*/g,
  sequelize: /sequelize\.query\s*\(\s*/g,
  "node-pg-migrate": /pgm\.sql\s*\(\s*/g,
  rails: /\bexecute\s*\(?\s*/g,
  django: /migrations\.RunSQL\s*\(\s*(?:sql\s*=\s*)?/g,
  alembic: /op\.execute\s*\(\s*/g,
  laravel: /DB::(?:statement|unprepared)\s*\(\s*/g
};

/** Reads one string literal at `i`: '...', "...", `...`, Python """...""" (with r/f/b prefix), or a Ruby heredoc. */
function stringAt(text: string, i: number): { value: string; start: number } | null {
  const pre = /^[rRfFbBuU]{0,2}/.exec(text.slice(i))![0];
  let j = i + pre.length;
  const heredoc = /^<<[~-]?(['"]?)(\w+)\1/.exec(text.slice(j));
  if (heredoc) {
    const bodyStart = text.indexOf("\n", j) + 1;
    const end = new RegExp(`^[ \\t]*${heredoc[2]}\\b`, "m").exec(text.slice(bodyStart));
    return { value: text.slice(bodyStart, end ? bodyStart + end.index : text.length), start: bodyStart };
  }
  for (const q of ['"""', "'''"]) {
    if (text.startsWith(q, j)) {
      const end = text.indexOf(q, j + 3);
      return { value: text.slice(j + 3, end < 0 ? text.length : end), start: j + 3 };
    }
  }
  const q = text[j];
  if (q !== "'" && q !== '"' && q !== "`") return null;
  let k = j + 1;
  while (k < text.length && text[k] !== q) k += text[k] === "\\" ? 2 : 1;
  return { value: text.slice(j + 1, k), start: j + 1 };
}

const META = new Map(MIGRATION_RULES.map((r) => [r.id, r]));

const GENERIC_FIX: Record<string, string> = {
  MIG002: "Add a CHECK (column IS NOT NULL) constraint without validation, validate it in a separate migration, then set NOT NULL.",
  MIG003: "Add the column as nullable or with a default, backfill existing rows, then make it NOT NULL in a later migration.",
  MIG005: "Add a new column with the new type, backfill in batches, switch the code over, then drop the old column.",
  MIG006: "Add the constraint without validating existing rows first, then validate it in a separate migration.",
  MIG007: "Create the unique index concurrently first, then attach the constraint to that index.",
  MIG008: "Use expand/contract: add the new column or table, write to both, switch reads, and remove the old one in a later release.",
  MIG010: "Stop using it in an earlier deploy, back up the data if needed, then drop it in a later release.",
  MIG011: "Drop the index concurrently in a migration of its own."
};

const CONCURRENT_FIX: Record<MigrationTool, string> = {
  rails: "Use add_index ..., algorithm: :concurrently and add disable_ddl_transaction! to this migration.",
  django: "Use AddIndexConcurrently (django.contrib.postgres.operations) and set atomic = False on the migration.",
  alembic: "Pass postgresql_concurrently=True and run it inside `with op.get_context().autocommit_block():`.",
  laravel: "Laravel cannot build indexes concurrently: use DB::statement('CREATE INDEX CONCURRENTLY ...') in a migration with public $withinTransaction = false;.",
  knex: "Use knex.raw('CREATE INDEX CONCURRENTLY ...') in a migration of its own and export config = { transaction: false }.",
  sequelize: "Pass { concurrently: true } to addIndex and run this migration outside a transaction.",
  typeorm: "Use queryRunner.query('CREATE INDEX CONCURRENTLY ...') and set transaction = false on the migration class.",
  "node-pg-migrate": "Pass { concurrently: true } and call pgm.noTransaction() in this migration."
};

const RAILS_FIX: Record<string, string> = {
  MIG006: "Use add_foreign_key ..., validate: false here, then validate_foreign_key in a later migration.",
  MIG002: "Add a check constraint with validate: false, validate it in a later migration, then change_column_null."
};

const WHAT: Record<string, (t: string, c?: string) => string> = {
  MIG001: (t) => `builds an index on existing table "${t}" without CONCURRENTLY, so writes to "${t}" wait until it finishes.`,
  MIG002: (t, c) => `makes "${t}"."${c}" NOT NULL, which scans the table under an ACCESS EXCLUSIVE lock: reads and writes wait.`,
  MIG003: (t, c) => `adds required column "${t}"."${c}" with no default. If "${t}" has rows, the migration fails at deploy time.`,
  MIG005: (t, c) => `changes the type of "${t}"."${c}", which usually rewrites the whole table under an ACCESS EXCLUSIVE lock.`,
  MIG006: (t) => `adds a constraint on existing table "${t}" that is checked against every row while writes are blocked.`,
  MIG007: (t) => `adds a unique constraint on existing table "${t}", building its index under an ACCESS EXCLUSIVE lock.`,
  MIG008: (t, c) => `renames ${c ? `"${t}"."${c}"` : `table "${t}"`}. App instances still on the previous release use the old name and fail during rollout.`,
  MIG010: (t, c) => `drops ${c ? `column "${t}"."${c}"` : `table "${t}"`}. The data is gone permanently, and running code that reads it will fail.`,
  MIG011: (t) => `drops an index on "${t}" without CONCURRENTLY, locking the table against reads and writes.`
};

export interface CodeMigrationResult {
  findings: Finding[];
  droppedColumns: DroppedColumn[];
  filesChecked: string[];
}

export function analyzeCodeMigration(m: CodeMigration, original: string, shared?: Set<string>): { findings: Finding[]; droppedColumns: DroppedColumn[] } {
  const text = upSection(m.tool, original);
  const tool = m.tool;
  const findings: Finding[] = [];
  const droppedColumns: DroppedColumn[] = [];
  const newTables = shared ?? new Set<string>();
  const isNew = (t: string) => newTables.has(t.toLowerCase());
  const markNew = (t: string) => newTables.add(t.toLowerCase());

  const emit = (ruleId: string, idx: number, table: string, column?: string) => {
    if (!table || isNew(table)) return;
    const meta = META.get(ruleId)!;
    const fix = ruleId === "MIG001" ? CONCURRENT_FIX[tool] : (tool === "rails" && RAILS_FIX[ruleId]) || GENERIC_FIX[ruleId];
    findings.push({ ruleId, severity: meta.severity, title: meta.description, message: `${TOOL_NAME[tool]} migration ${WHAT[ruleId](table, column)}`, fix, file: m.rel, line: lineOf(text, idx) });
    if (ruleId === "MIG010" && column) droppedColumns.push({ table, column, file: m.rel, line: lineOf(text, idx) });
  };

  // Raw SQL first: CREATE TABLE inside it also marks tables as new.
  const rawRe = new RegExp(RAW_SQL[tool].source, "g");
  let r: RegExpExecArray | null;
  while ((r = rawRe.exec(text))) {
    const s = stringAt(text, r.index + r[0].length);
    if (!s || !/\b(CREATE|ALTER|DROP)\b/i.test(s.value)) continue;
    const res = analyzeStatements(splitSql(s.value), { file: m.rel, newTables: new Set([...newTables].map((t) => t)) });
    const offset = lineOf(text, s.start) - 1;
    for (const f of res.findings) findings.push({ ...f, line: f.line + offset });
    for (const d of res.droppedColumns) droppedColumns.push({ ...d, line: d.line + offset });
    for (const st of splitSql(s.value)) {
      const c = /^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([\w.]+)"?/i.exec(st.text);
      if (c) markNew(c[1].split(".").pop()!);
    }
  }

  const each = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let x: RegExpExecArray | null;
    while ((x = g.exec(text))) fn(x);
  };
  /** Args of the call whose name ends at match end - 1 ("(" included in the match). */
  const callArgs = (x: RegExpExecArray) => argsAt(text, x.index + x[0].length - 1);

  if (tool === "rails") {
    each(/\bcreate_table\s*\(?\s*:?["']?(\w+)/, (x) => markNew(x[1]));
    const sym = String.raw`\s*\(?\s*:?["']?(\w+)["']?`;
    const lineAt = (x: RegExpExecArray) => text.slice(x.index, text.indexOf("\n", x.index) < 0 ? text.length : text.indexOf("\n", x.index));
    const assured = (x: RegExpExecArray) => /safety_assured/.test(text.slice(Math.max(0, x.index - 200), x.index));
    each(new RegExp(`\\badd_index${sym}`), (x) => !assured(x) && !/algorithm:\s*:concurrently/.test(lineAt(x)) && emit("MIG001", x.index, x[1]));
    each(new RegExp(`\\bremove_index${sym}`), (x) => !assured(x) && !/algorithm:\s*:concurrently/.test(lineAt(x)) && emit("MIG011", x.index, x[1]));
    each(new RegExp(`\\badd_column${sym}\\s*,\\s*:?["']?(\\w+)`), (x) => !assured(x) && /null:\s*false/.test(lineAt(x)) && !/default:/.test(lineAt(x)) && emit("MIG003", x.index, x[1], x[2]));
    each(new RegExp(`\\bchange_column${sym}\\s*,\\s*:?["']?(\\w+)`), (x) => !assured(x) && emit("MIG005", x.index, x[1], x[2]));
    each(new RegExp(`\\bchange_column_null${sym}\\s*,\\s*:?["']?(\\w+)["']?\\s*,\\s*false`), (x) => !assured(x) && emit("MIG002", x.index, x[1], x[2]));
    each(new RegExp(`\\badd_foreign_key${sym}`), (x) => !assured(x) && !/validate:\s*false/.test(lineAt(x)) && emit("MIG006", x.index, x[1]));
    each(new RegExp(`\\badd_reference${sym}`), (x) => {
      if (assured(x)) return;
      const l = lineAt(x);
      if (/foreign_key:\s*(true|\{)/.test(l) && !/validate:\s*false/.test(l)) emit("MIG006", x.index, x[1]);
      if (!/index:\s*false/.test(l) && !/algorithm:\s*:concurrently/.test(l)) emit("MIG001", x.index, x[1]);
    });
    each(new RegExp(`\\brename_column${sym}\\s*,\\s*:?["']?(\\w+)`), (x) => !assured(x) && emit("MIG008", x.index, x[1], x[2]));
    each(new RegExp(`\\brename_table${sym}`), (x) => !assured(x) && emit("MIG008", x.index, x[1]));
    each(new RegExp(`\\bremove_column${sym}\\s*,\\s*:?["']?(\\w+)`), (x) => !assured(x) && emit("MIG010", x.index, x[1], x[2]));
    each(new RegExp(`\\bdrop_table${sym}`), (x) => !assured(x) && emit("MIG010", x.index, x[1]));
  }

  if (tool === "django") {
    const kw = (name: string) => String.raw`\s*${name}\s*=\s*['"](\w+)['"]`;
    each(new RegExp(`migrations\\.CreateModel\\(${kw("name")}`), (x) => markNew(x[1]));
    each(new RegExp(`migrations\\.AddIndex\\(${kw("model_name")}`), (x) => emit("MIG001", x.index, x[1]));
    each(new RegExp(`migrations\\.RemoveIndex\\(${kw("model_name")}`), (x) => emit("MIG011", x.index, x[1]));
    each(/migrations\.AddConstraint\(/, (x) => {
      const a = callArgs(x);
      const t = /model_name\s*=\s*['"](\w+)['"]/.exec(a)?.[1];
      if (t) emit(/UniqueConstraint/.test(a) ? "MIG007" : "MIG006", x.index, t);
    });
    each(/migrations\.AddField\(/, (x) => {
      const a = callArgs(x);
      const t = /model_name\s*=\s*['"](\w+)['"]/.exec(a)?.[1];
      if (!t) return;
      if (/unique\s*=\s*True/.test(a)) emit("MIG007", x.index, t);
      else if (/db_index\s*=\s*True/.test(a)) emit("MIG001", x.index, t);
    });
    each(new RegExp(`migrations\\.RenameField\\(${kw("model_name")}\\s*,${kw("old_name")}`), (x) => emit("MIG008", x.index, x[1], x[2]));
    each(new RegExp(`migrations\\.RenameModel\\(${kw("old_name")}`), (x) => emit("MIG008", x.index, x[1]));
    each(new RegExp(`migrations\\.RemoveField\\(${kw("model_name")}\\s*,${kw("name")}`), (x) => emit("MIG010", x.index, x[1], x[2]));
    each(new RegExp(`migrations\\.DeleteModel\\(${kw("name")}`), (x) => emit("MIG010", x.index, x[1]));
  }

  if (tool === "alembic") {
    each(/op\.create_table\(\s*['"](\w+)['"]/, (x) => markNew(x[1]));
    // with op.batch_alter_table("posts") as batch_op: ... batch_op.add_column(...)
    const batches: { at: number; table: string }[] = [];
    each(/batch_alter_table\(\s*['"](\w+)['"]/, (x) => batches.push({ at: x.index, table: x[1] }));
    const batchTable = (i: number) => [...batches].reverse().find((b) => b.at < i)?.table ?? "";
    each(/\b(op|batch_op)\.(create_index|drop_index|add_column|alter_column|drop_column|drop_table|rename_table|create_foreign_key|create_unique_constraint|create_check_constraint)\(/, (x) => {
      const batch = x[1] === "batch_op";
      const op = x[2];
      const a = callArgs(x);
      const s = strings(a);
      const kwTable = /table_name\s*=\s*['"](\w+)['"]/.exec(a)?.[1];
      const table = batch ? batchTable(x.index) : ["create_index", "drop_index", "create_foreign_key", "create_unique_constraint", "create_check_constraint"].includes(op) ? kwTable ?? s[1] : s[0];
      const col = batch ? s[0] : s[1];
      switch (op) {
        case "create_index":
          if (!/postgresql_concurrently\s*=\s*True/.test(a)) emit("MIG001", x.index, table);
          break;
        case "drop_index":
          if (!/postgresql_concurrently\s*=\s*True/.test(a)) emit("MIG011", x.index, table || "(table)");
          break;
        case "add_column": {
          const colName = /Column\(\s*['"](\w+)['"]/.exec(a)?.[1];
          if (/nullable\s*=\s*False/.test(a) && !/server_default\s*=/.test(a)) emit("MIG003", x.index, table, colName);
          break;
        }
        case "alter_column":
          if (/new_column_name\s*=/.test(a)) emit("MIG008", x.index, table, col);
          if (/type_\s*=/.test(a)) emit("MIG005", x.index, table, col);
          if (/nullable\s*=\s*False/.test(a)) emit("MIG002", x.index, table, col);
          break;
        case "drop_column":
          emit("MIG010", x.index, table, col);
          break;
        case "drop_table":
          emit("MIG010", x.index, s[0]);
          break;
        case "rename_table":
          emit("MIG008", x.index, s[0]);
          break;
        case "create_foreign_key":
        case "create_check_constraint":
          if (!/not_valid/.test(a)) emit("MIG006", x.index, table);
          break;
        case "create_unique_constraint":
          emit("MIG007", x.index, table);
          break;
      }
    });
  }

  if (tool === "laravel") {
    each(/Schema::create\(\s*['"](\w+)['"]/, (x) => markNew(x[1]));
    each(/Schema::(?:drop|dropIfExists)\(\s*['"](\w+)['"]/, (x) => emit("MIG010", x.index, x[1]));
    each(/Schema::rename\(\s*['"](\w+)['"]/, (x) => emit("MIG008", x.index, x[1]));
    each(/Schema::table\(\s*['"](\w+)['"]\s*,/, (x) => {
      const table = x[1];
      const open = text.indexOf("{", x.index);
      if (open < 0) return;
      const body = argsAt(text, open);
      for (const st of statements(body)) {
        const s = st.text.trim();
        if (!s.startsWith("$table->")) continue;
        const at = open + 1 + st.offset + (st.text.length - st.text.trimStart().length);
        const col = strings(s)[0];
        if (/->change\(\)/.test(s)) emit("MIG005", at, table, col);
        else if (/^\$table->(index|fullText|spatialIndex)\(|->index\(/.test(s)) emit("MIG001", at, table);
        else if (/^\$table->unique\(|->unique\(/.test(s)) emit("MIG007", at, table);
        else if (/^\$table->renameColumn\(/.test(s)) emit("MIG008", at, table, col);
        else if (/^\$table->dropColumn\(/.test(s)) for (const c of strings(s)) emit("MIG010", at, table, c);
        else if (/^\$table->(dropIndex|dropUnique|dropFullText)\(/.test(s)) emit("MIG011", at, table);
        else if (/^\$table->\w+\(\s*['"]\w+['"]/.test(s) && !/^\$table->(drop|rename|foreign\b)/.test(s) && !/->(nullable|default|useCurrent|storedAs|virtualAs)\(/.test(s)) emit("MIG003", at, table, col);
        if (/^\$table->foreign\(|->(constrained|references)\(/.test(s)) emit("MIG006", at, table);
      }
    });
  }

  if (tool === "knex") {
    each(/\.createTable(?:IfNotExists)?\(\s*['"`](\w+)['"`]/, (x) => markNew(x[1]));
    each(/\.dropTable(?:IfExists)?\(\s*['"`](\w+)['"`]/, (x) => emit("MIG010", x.index, x[1]));
    each(/\.renameTable\(\s*['"`](\w+)['"`]/, (x) => emit("MIG008", x.index, x[1]));
    each(/\.(?:alterTable|table)\(\s*['"`](\w+)['"`]\s*,/, (x) => {
      const table = x[1];
      const open = x.index + x[0].indexOf("(");
      const args = argsAt(text, open);
      const bodyStart = args.indexOf("{");
      const body = bodyStart >= 0 ? args.slice(bodyStart + 1) : args.slice(args.indexOf(",") + 1);
      const base = open + 1 + (bodyStart >= 0 ? bodyStart + 1 : args.indexOf(",") + 1);
      for (const st of statements(body)) {
        const s = st.text.trim();
        if (!s) continue;
        const at = base + st.offset + (st.text.length - st.text.trimStart().length);
        const col = strings(s)[0];
        if (/\.alter\(\)/.test(s)) emit("MIG005", at, table, col);
        else if (/^\w+\.index\(|\.index\(\s*\)/.test(s)) emit("MIG001", at, table);
        else if (/^\w+\.unique\(|\.unique\(\s*\)/.test(s)) emit("MIG007", at, table);
        else if (/^\w+\.renameColumn\(/.test(s)) emit("MIG008", at, table, col);
        else if (/^\w+\.dropColumns?\(/.test(s)) for (const c of strings(s)) emit("MIG010", at, table, c);
        else if (/^\w+\.(dropIndex|dropUnique)\(/.test(s)) emit("MIG011", at, table);
        else if (/\.notNullable\(\)/.test(s) && !/\.defaultTo\(/.test(s) && /^\w+\.\w+\(\s*['"`]/.test(s)) emit("MIG003", at, table, col);
        if (/\.(references|foreign)\(/.test(s)) emit("MIG006", at, table);
      }
    });
  }

  if (tool === "sequelize") {
    each(/queryInterface\.createTable\(\s*['"`](\w+)['"`]/, (x) => markNew(x[1]));
    each(/queryInterface\.(addIndex|removeIndex|addColumn|changeColumn|renameColumn|renameTable|removeColumn|dropTable|addConstraint)\(/, (x) => {
      const a = callArgs(x);
      const s = strings(a);
      const [table, col] = s;
      switch (x[1]) {
        case "addIndex":
          if (!/concurrently\s*:\s*true/.test(a)) emit("MIG001", x.index, table);
          break;
        case "removeIndex":
          if (!/concurrently\s*:\s*true/.test(a)) emit("MIG011", x.index, table);
          break;
        case "addColumn":
          if (/allowNull\s*:\s*false/.test(a) && !/defaultValue\s*:/.test(a)) emit("MIG003", x.index, table, col);
          if (/references\s*:/.test(a)) emit("MIG006", x.index, table);
          break;
        case "changeColumn":
          emit("MIG005", x.index, table, col);
          break;
        case "renameColumn":
          emit("MIG008", x.index, table, col);
          break;
        case "renameTable":
          emit("MIG008", x.index, table);
          break;
        case "removeColumn":
          emit("MIG010", x.index, table, col);
          break;
        case "dropTable":
          emit("MIG010", x.index, table);
          break;
        case "addConstraint":
          emit(/type\s*:\s*['"`]unique['"`]/i.test(a) ? "MIG007" : "MIG006", x.index, table);
          break;
      }
    });
  }

  if (tool === "typeorm") {
    each(/createTable\(\s*new\s+Table\(\s*\{\s*name\s*:\s*['"`](\w+)['"`]/, (x) => markNew(x[1]));
    each(/queryRunner\.(createIndex|dropIndex|addColumn|changeColumn|renameColumn|renameTable|dropColumn|dropTable|createForeignKey|createUniqueConstraint|createCheckConstraint)\(/, (x) => {
      const a = callArgs(x);
      const s = strings(a);
      const table = s[0];
      switch (x[1]) {
        case "createIndex":
          if (!/isConcurrent\s*:\s*true/.test(a)) emit("MIG001", x.index, table);
          break;
        case "dropIndex":
          emit("MIG011", x.index, table);
          break;
        case "addColumn": {
          // TableColumn is NOT NULL unless isNullable: true
          const col = /name\s*:\s*['"`](\w+)['"`]/.exec(a)?.[1];
          if (!/isNullable\s*:\s*true/.test(a) && !/default\s*:/.test(a)) emit("MIG003", x.index, table, col);
          break;
        }
        case "changeColumn":
          emit("MIG005", x.index, table, s[1]);
          break;
        case "renameColumn":
          emit("MIG008", x.index, table, s[1]);
          break;
        case "renameTable":
          emit("MIG008", x.index, table);
          break;
        case "dropColumn":
          emit("MIG010", x.index, table, s[1]);
          break;
        case "dropTable":
          emit("MIG010", x.index, table);
          break;
        case "createForeignKey":
        case "createCheckConstraint":
          emit("MIG006", x.index, table);
          break;
        case "createUniqueConstraint":
          emit("MIG007", x.index, table);
          break;
      }
    });
  }

  if (tool === "node-pg-migrate") {
    each(/pgm\.createTable\(\s*['"`](\w+)['"`]/, (x) => markNew(x[1]));
    each(/pgm\.(createIndex|addIndex|dropIndex|addColumns?|alterColumn|renameColumn|renameTable|dropColumns?|dropTable|addConstraint|createConstraint)\(/, (x) => {
      const a = callArgs(x);
      const s = strings(a);
      const table = s[0];
      switch (x[1]) {
        case "createIndex":
        case "addIndex":
          if (!/concurrently\s*:\s*true/.test(a)) emit("MIG001", x.index, table);
          break;
        case "dropIndex":
          if (!/concurrently\s*:\s*true/.test(a)) emit("MIG011", x.index, table);
          break;
        case "addColumn":
        case "addColumns": {
          const col = /\{\s*['"]?(\w+)['"]?\s*:/.exec(a.slice(a.indexOf(",") + 1))?.[1];
          if (/notNull\s*:\s*true/.test(a) && !/default\s*:/.test(a)) emit("MIG003", x.index, table, col);
          if (/references\s*:/.test(a)) emit("MIG006", x.index, table);
          break;
        }
        case "alterColumn":
          if (/type\s*:/.test(a)) emit("MIG005", x.index, table, s[1]);
          if (/notNull\s*:\s*true/.test(a)) emit("MIG002", x.index, table, s[1]);
          break;
        case "renameColumn":
          emit("MIG008", x.index, table, s[1]);
          break;
        case "renameTable":
          emit("MIG008", x.index, table);
          break;
        case "dropColumn":
        case "dropColumns":
          for (const c of s.slice(1).filter((v) => !/^(cascade|ifExists)$/.test(v))) emit("MIG010", x.index, table, c);
          break;
        case "dropTable":
          emit("MIG010", x.index, table);
          break;
        case "addConstraint":
        case "createConstraint":
          if (/unique\s*:/.test(a)) emit("MIG007", x.index, table);
          else if (/(foreignKeys|references|check)\s*:/.test(a)) emit("MIG006", x.index, table);
          break;
      }
    });
  }

  findings.sort((a, b) => a.line - b.line);
  return { findings, droppedColumns };
}

export function checkCodeMigrations(root: string, files: CodeMigration[], onlyFiles?: Set<string>): CodeMigrationResult {
  const findings: Finding[] = [];
  const droppedColumns: DroppedColumn[] = [];
  const filesChecked: string[] = [];
  const shared = new Set<string>();
  for (const m of files) {
    if (onlyFiles && !onlyFiles.has(m.rel)) continue;
    filesChecked.push(m.rel);
    let text: string;
    try {
      text = fs.readFileSync(m.abs, "utf8");
    } catch {
      continue;
    }
    const res = analyzeCodeMigration(m, text, onlyFiles ? shared : undefined);
    findings.push(...res.findings);
    droppedColumns.push(...res.droppedColumns);
  }
  return { findings, droppedColumns, filesChecked };
}

/** Tables created by Knex migrations, for Knex/Kysely queries in projects with no ORM schema. */
export function knexTables(files: CodeMigration[], ownerFields: string[]): PrismaModel[] {
  const out: PrismaModel[] = [];
  for (const m of files.filter((f) => f.tool === "knex")) {
    let text: string;
    try {
      text = upSection("knex", fs.readFileSync(m.abs, "utf8"));
    } catch {
      continue;
    }
    const re = /\.createTable(?:IfNotExists)?\(\s*['"`](\w+)['"`]/g;
    let x: RegExpExecArray | null;
    while ((x = re.exec(text))) {
      const open = x.index + x[0].indexOf("(");
      const body = argsAt(text, open);
      const fields: PrismaField[] = [];
      const col = /\b\w+\.\w+\(\s*['"`](\w+)['"`]/g;
      let c: RegExpExecArray | null;
      while ((c = col.exec(body))) {
        fields.push({ name: camel(c[1]), dbName: c[1], type: "column", optional: true, list: false, isRelation: false, relationFields: [], line: lineOf(text, open + 1 + c.index) });
      }
      out.push({ name: x[1], accessor: x[1], dbName: x[1], fields, ownerFields: fields.filter((f) => isOwnerName(f.dbName, ownerFields)).map((f) => f.name), ownerRelations: [], file: m.rel, line: lineOf(text, x.index), source: "knex" });
    }
  }
  return out;
}
