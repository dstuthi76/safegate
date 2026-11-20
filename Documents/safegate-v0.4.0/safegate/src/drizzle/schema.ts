import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { PrismaField, PrismaModel } from "../prisma/schema";
import { toPosix } from "../util/files";

/**
 * Reads Drizzle ORM table definitions:
 *   export const posts = pgTable("posts", { id: serial("id"), authorId: text("author_id").notNull() })
 * Each table becomes a model keyed by its variable name (the name used in db.select().from(posts)
 * and db.query.posts), with its SQL table name as dbName.
 */
const TABLE_FN = /^(pgTable|mysqlTable|sqliteTable|singlestoreTable|table)$/;
const QUICK = /\b(pgTable|mysqlTable|sqliteTable|singlestoreTable|pgTableCreator|mysqlTableCreator|sqliteTableCreator)\s*\(|\.table\s*\(/;

function camel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** The SQL column name inside text("author_id").notNull() -> author_id */
function columnName(expr: ts.Expression): string | null {
  let e: ts.Expression = expr;
  while (ts.isCallExpression(e)) {
    const callee = e.expression;
    if (ts.isIdentifier(callee)) {
      const first = e.arguments[0];
      return first && ts.isStringLiteralLike(first) ? first.text : null;
    }
    if (ts.isPropertyAccessExpression(callee)) {
      e = callee.expression;
      continue;
    }
    return null;
  }
  return null;
}

function columnType(expr: ts.Expression): string {
  let e: ts.Expression = expr;
  while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) e = e.expression.expression;
  return ts.isCallExpression(e) && ts.isIdentifier(e.expression) ? e.expression.text : "column";
}

export function parseDrizzleText(text: string, rel: string, ownerFieldNames: string[]): PrismaModel[] {
  if (!QUICK.test(text)) return [];
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith(".js") || rel.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const models: PrismaModel[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  // const createTable = pgTableCreator((name) => `app_${name}`)  (used by create-t3-app)
  const creators = new Map<string, { prefix: string; suffix: string }>();
  const findCreators = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && /TableCreator$/.test(node.initializer.expression.text)) {
      // (name) => `app_${name}` gives the real table name app_<name>
      let affix = { prefix: "", suffix: "" };
      const f = node.initializer.arguments[0];
      if (f && (ts.isArrowFunction(f) || ts.isFunctionExpression(f)) && f.parameters[0] && ts.isIdentifier(f.parameters[0].name) && ts.isTemplateExpression(f.body as ts.Node) ) {
        const t = f.body as unknown as ts.TemplateExpression;
        const span = t.templateSpans[0];
        if (t.templateSpans.length === 1 && ts.isIdentifier(span.expression) && span.expression.text === (f.parameters[0].name as ts.Identifier).text) affix = { prefix: t.head.text, suffix: span.literal.text };
      }
      creators.set(node.name.text, affix);
    }
    ts.forEachChild(node, findCreators);
  };
  findCreators(sf);

  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      const call = node.initializer;
      const callee = call.expression;
      const fnName = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      const [nameArg, colsArg] = call.arguments;
      if ((TABLE_FN.test(fnName) || creators.has(fnName)) && nameArg && ts.isStringLiteralLike(nameArg) && colsArg) {
        // Columns may be an object or a callback returning one: pgTable("t", (t) => ({ ... }))
        let cols: ts.Expression | undefined = colsArg;
        if (ts.isArrowFunction(cols) || ts.isFunctionExpression(cols)) {
          const body: ts.Node = cols.body;
          cols = ts.isParenthesizedExpression(body as ts.Expression) ? (body as ts.ParenthesizedExpression).expression : ts.isObjectLiteralExpression(body as ts.Expression) ? (body as ts.Expression) : undefined;
        }
        if (cols && ts.isObjectLiteralExpression(cols)) {
          const fields: PrismaField[] = [];
          for (const p of cols.properties) {
            if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) continue;
            const key = p.name.text;
            fields.push({
              name: key,
              dbName: columnName(p.initializer) ?? key,
              type: columnType(p.initializer),
              optional: !/\.notNull\(\)|\.primaryKey\(\)/.test(p.initializer.getText(sf)),
              list: false,
              isRelation: false,
              relationFields: [],
              line: line(p)
            });
          }
          const ownerFields = fields.filter((f) => ownerFieldNames.includes(f.name) || ownerFieldNames.includes(camel(f.dbName))).map((f) => f.name);
          const affix = creators.get(fnName) ?? { prefix: "", suffix: "" };
          models.push({ name: node.name.text, accessor: node.name.text, dbName: affix.prefix + nameArg.text + affix.suffix, fields, ownerFields, ownerRelations: [], file: rel, line: line(node) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return models;
}

export function loadDrizzleModels(root: string, sourceFiles: string[], ownerFieldNames: string[]): PrismaModel[] {
  const out: PrismaModel[] = [];
  for (const abs of sourceFiles) {
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (!/drizzle-orm/.test(text) && !QUICK.test(text)) continue;
    out.push(...parseDrizzleText(text, toPosix(path.relative(root, abs)), ownerFieldNames));
  }
  return out;
}
