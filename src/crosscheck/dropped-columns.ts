import * as fs from "fs";
import * as path from "path";
import { Finding } from "../types";
import { PrismaSchema } from "../prisma/schema";
import { DroppedColumn, splitTopLevel } from "../migrations/rules";
import { IDENT, splitSql, unquoteIdent } from "../migrations/sql";
import { lineOf, toPosix } from "../util/files";

const GENERIC = new Set(["id", "name", "type", "data", "value", "key", "status", "title", "email", "createdAt", "updatedAt"]);

/** Columns (table.column) added in each migration file, in order. */
function addedColumnsByFile(files: string[], root: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const abs of files) {
    const rel = toPosix(path.relative(root, abs));
    const set = new Set<string>();
    for (const stmt of splitSql(fs.readFileSync(abs, "utf8"))) {
      const create = new RegExp(`^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})\\s*\\((.*)\\)`, "i").exec(stmt.text);
      if (create) {
        const t = unquoteIdent(create[1]);
        for (const col of splitTopLevel(create[2])) {
          const c = new RegExp(`^(${IDENT})\\s`).exec(col);
          if (c && !/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)\b/i.test(col)) set.add(`${t}.${unquoteIdent(c[1])}`);
        }
        continue;
      }
      const alter = new RegExp(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${IDENT})\\s+(.*)$`, "i").exec(stmt.text);
      if (!alter) continue;
      const t = unquoteIdent(alter[1]);
      for (const action of splitTopLevel(alter[2])) {
        const add = new RegExp(`^ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})\\s`, "i").exec(action);
        if (add && !/^ADD\s+(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)\b/i.test(action)) set.add(`${t}.${unquoteIdent(add[1])}`);
        const ren = new RegExp(`^RENAME\\s+(?:COLUMN\\s+)?(${IDENT})\\s+TO\\s+(${IDENT})`, "i").exec(action);
        if (ren) set.add(`${t}.${unquoteIdent(ren[2])}`);
      }
    }
    out.set(rel, set);
  }
  return out;
}

/** Blanks out line and block comments while keeping offsets and line numbers intact. */
export function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/.*$/gm, (m, pre) => {
    const keep = typeof pre === "string" ? pre : "";
    return keep + m.slice(keep.length).replace(/[^\n]/g, " ");
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * XCHK001: a column dropped by a migration is still referenced by application code,
 * or schema.prisma still declares it (schema and migrations disagree).
 */
export function crossCheckDroppedColumns(
  root: string,
  dropped: DroppedColumn[],
  allMigrationFiles: string[],
  schema: PrismaSchema | null,
  sourceFiles: string[]
): Finding[] {
  if (!dropped.length) return [];
  const findings: Finding[] = [];
  const adds = addedColumnsByFile(allMigrationFiles, root);
  const order = allMigrationFiles.map((f) => toPosix(path.relative(root, f)));
  const sources = sourceFiles.map((abs) => ({ rel: toPosix(path.relative(root, abs)), text: stripComments(fs.readFileSync(abs, "utf8")) }));

  for (const d of dropped) {
    // Re-added later in history? Then it exists again and is fine.
    const idx = order.indexOf(d.file);
    const readded = order.slice(idx + 1).some((f) => adds.get(f)?.has(`${d.table}.${d.column}`));
    if (readded) continue;

    const model = schema?.byTable.get(d.table);
    const field = model?.fields.find((f) => f.dbName === d.column);
    if (model && field) {
      findings.push({
        ruleId: "XCHK001",
        severity: "high",
        title: "A dropped column is still declared in schema.prisma or used in code.",
        message: `Migration drops "${d.table}"."${d.column}", but schema.prisma still declares ${model.name}.${field.name} (${model.file}:${field.line}). Prisma Client will query a column that no longer exists.`,
        fix: `Remove ${model.name}.${field.name} from schema.prisma (and from code) in the same change, or drop the column in a later release once nothing uses it.`,
        file: d.file,
        line: d.line
      });
      continue;
    }

    const fieldName = d.column; // Prisma default: field name == column name
    const accessor = model ? model.accessor : d.table.charAt(0).toLowerCase() + d.table.slice(1);
    const modelName = model ? model.name : d.table;
    const modelRe = new RegExp(`\\.${escapeRe(accessor)}\\b|\\b${escapeRe(modelName)}\\b|"${escapeRe(d.table)}"`);
    const fieldRe = GENERIC.has(fieldName)
      ? new RegExp(`\\.${escapeRe(accessor)}\\.[\\s\\S]{0,300}?\\b${escapeRe(fieldName)}\\s*:|"${escapeRe(d.column)}"`, "g")
      : new RegExp(`\\b${escapeRe(fieldName)}\\b|"${escapeRe(d.column)}"`, "g");

    const hits: string[] = [];
    for (const src of sources) {
      if (!modelRe.test(src.text)) continue;
      fieldRe.lastIndex = 0;
      const m = fieldRe.exec(src.text);
      if (m) {
        const at = m.index + Math.max(0, m[0].lastIndexOf(fieldName));
        hits.push(`${src.rel}:${lineOf(src.text, at)}`);
      }
    }
    if (hits.length) {
      findings.push({
        ruleId: "XCHK001",
        severity: "high",
        title: "A dropped column is still declared in schema.prisma or used in code.",
        message: `Migration drops "${d.table}"."${d.column}", but code still references it at ${hits.slice(0, 3).join(", ")}${hits.length > 3 ? ` and ${hits.length - 3} more` : ""}. Those queries will fail after the migration runs.`,
        fix: "Remove these references and deploy that change first; drop the column in a later release.",
        file: d.file,
        line: d.line
      });
    }
  }
  return findings;
}
