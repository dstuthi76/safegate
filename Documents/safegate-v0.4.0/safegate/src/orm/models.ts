import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { PrismaField, PrismaModel } from "../prisma/schema";
import { splitTopLevel } from "../migrations/rules";
import { IDENT, splitSql, unquoteIdent } from "../migrations/sql";
import { toPosix } from "../util/files";

/**
 * Reads data models from the ORMs other than Prisma and Drizzle, and from migrations:
 *  - TypeORM and MikroORM entities (@Entity), Nest Mongoose (@Schema), sequelize-typescript (@Table)
 *  - Sequelize Model.init(...) / sequelize.define(...) and belongsTo(...) associations
 *  - Mongoose new Schema({...}) + model("Name", schema)
 *  - Tables created by SQL migrations or Knex createTable(...), for Knex, Kysely and raw SQL queries
 * Every model records which fields tie a row to its owner.
 */

/** Models a row can belong to: a foreign key to one of these makes the field an owner field. */
export const OWNER_TARGET = /^(user|account|member|organi[sz]ation|org|team|workspace|tenant|customer|profile|owner|author|creator)s?$/i;

export function camel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function isOwnerName(name: string, ownerFields: string[]): boolean {
  const low = name.toLowerCase();
  return ownerFields.includes(name) || ownerFields.includes(camel(name)) || ownerFields.some((f) => f.toLowerCase() === low);
}

function snake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function field(name: string, dbName: string, type: string, line: number): PrismaField {
  return { name, dbName, type, optional: true, list: false, isRelation: false, relationFields: [], line };
}

function decorators(node: ts.Node): ts.Decorator[] {
  return ts.canHaveDecorators(node) ? [...(ts.getDecorators(node) ?? [])] : [];
}

function decName(d: ts.Decorator): string {
  const e = d.expression;
  const callee = ts.isCallExpression(e) ? e.expression : e;
  return ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
}

function decArgs(d: ts.Decorator): readonly ts.Expression[] {
  return ts.isCallExpression(d.expression) ? d.expression.arguments : [];
}

function objString(obj: ts.Expression | undefined, keys: string[]): string | null {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && keys.includes(p.name.text) && ts.isStringLiteralLike(p.initializer)) return p.initializer.text;
  }
  return null;
}

/** () => User, User, "User", User.name -> User */
function targetName(e: ts.Expression | undefined): string | null {
  if (!e) return null;
  if ((ts.isArrowFunction(e) || ts.isFunctionExpression(e)) && !ts.isBlock(e.body)) return targetName(e.body as ts.Expression);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isStringLiteralLike(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text === "name" && ts.isIdentifier(e.expression) ? e.expression.text : e.name.text;
  return null;
}

const COLUMN_DECORATORS = new Set(["Column", "PrimaryColumn", "PrimaryGeneratedColumn", "CreateDateColumn", "UpdateDateColumn", "DeleteDateColumn", "VersionColumn", "Property", "PrimaryKey", "Prop", "ForeignKey", "RelationId", "Field"]);
const RELATION_DECORATORS = new Set(["ManyToOne", "OneToOne", "BelongsTo"]);

const line = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

/** @Entity / @Schema / @Table classes */
function classModels(sf: ts.SourceFile, rel: string, ownerFields: string[]): PrismaModel[] {
  const out: PrismaModel[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) && node.name) {
      const decs = decorators(node);
      const marker = decs.find((d) => ["Entity", "Schema", "Table"].includes(decName(d)));
      if (marker) {
        const arg = decArgs(marker)[0];
        const dbName = (arg && ts.isStringLiteralLike(arg) ? arg.text : objString(arg, ["name", "tableName", "collection"])) ?? snake(node.name.text);
        const fields: PrismaField[] = [];
        const owners: string[] = [];
        const ownerRelations: string[] = [];
        for (const m of node.members) {
          if (!ts.isPropertyDeclaration(m) || !m.name || !(ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) continue;
          const prop = m.name.text;
          const mdecs = decorators(m);
          const col = mdecs.find((d) => COLUMN_DECORATORS.has(decName(d)));
          const relDec = mdecs.find((d) => RELATION_DECORATORS.has(decName(d)));
          if (!col && !relDec) continue;
          const first = (relDec ? decArgs(relDec) : decArgs(col!))[0];
          let target = relDec ? targetName(first) : null;
          // @Prop({ type: Types.ObjectId, ref: "User" }) and @ForeignKey(() => User)
          if (!target && col) {
            const ref = col && decArgs(col)[0] && ts.isObjectLiteralExpression(decArgs(col)[0]) ? (decArgs(col)[0] as ts.ObjectLiteralExpression).properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === "ref") : undefined;
            if (ref && ts.isPropertyAssignment(ref)) target = targetName(ref.initializer);
            if (decName(col) === "ForeignKey") target = targetName(first);
          }
          const colName = (first && ts.isStringLiteralLike(first) && !relDec ? first.text : objString(first, ["name", "fieldName", "field"])) ?? prop;
          const f = field(prop, colName, target ?? "column", line(sf, m));
          f.isRelation = !!relDec;
          fields.push(f);
          const owner = isOwnerName(prop, ownerFields) || isOwnerName(colName, ownerFields) || (!!target && OWNER_TARGET.test(target));
          if (owner) {
            owners.push(prop);
            if (relDec) ownerRelations.push(prop);
          }
        }
        const source = decName(marker) === "Schema" ? "mongoose" : decName(marker) === "Table" ? "sequelize" : "typeorm";
        out.push({ name: node.name.text, accessor: node.name.text, dbName, fields, ownerFields: owners, ownerRelations, file: rel, line: line(sf, node), source });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function objectFields(sf: ts.SourceFile, obj: ts.ObjectLiteralExpression, ownerFields: string[], refKey: string | null): { fields: PrismaField[]; owners: string[] } {
  const fields: PrismaField[] = [];
  const owners: string[] = [];
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) continue;
    const name = p.name.text;
    let dbName = name;
    let target: string | null = null;
    if (ts.isObjectLiteralExpression(p.initializer)) {
      dbName = objString(p.initializer, ["field"]) ?? name;
      if (refKey) {
        const ref = p.initializer.properties.find((q) => ts.isPropertyAssignment(q) && q.name.getText(sf) === refKey);
        if (ref && ts.isPropertyAssignment(ref)) target = targetName(ref.initializer);
      }
      // Sequelize: references: { model: "users" }
      const refs = p.initializer.properties.find((q) => ts.isPropertyAssignment(q) && q.name.getText(sf) === "references");
      if (refs && ts.isPropertyAssignment(refs)) target = target ?? objString(refs.initializer, ["model"]);
    }
    fields.push(field(name, dbName, target ?? "column", line(sf, p)));
    if (isOwnerName(name, ownerFields) || isOwnerName(dbName, ownerFields) || (!!target && OWNER_TARGET.test(target))) owners.push(name);
  }
  return { fields, owners };
}

/** Name a model is used under: const Post = ..., export default ... -> fallback */
function assignedName(node: ts.Node, fallback: string): string {
  let cur: ts.Node = node;
  while (cur.parent && (ts.isBinaryExpression(cur.parent) || ts.isAsExpression(cur.parent) || ts.isParenthesizedExpression(cur.parent) || ts.isNonNullExpression(cur.parent) || ts.isSatisfiesExpression(cur.parent))) cur = cur.parent;
  if (cur.parent && ts.isVariableDeclaration(cur.parent) && ts.isIdentifier(cur.parent.name)) return cur.parent.name.text;
  return fallback;
}

interface Association {
  model: string;
  target: string;
  foreignKey: string | null;
}

function sequelizeAndMongoose(sf: ts.SourceFile, rel: string, ownerFields: string[], assoc: Association[]): PrismaModel[] {
  const out: PrismaModel[] = [];
  const schemas = new Map<string, { fields: PrismaField[]; owners: string[] }>();
  const visit = (node: ts.Node) => {
    // Mongoose: const PostSchema = new Schema({...})
    if (ts.isNewExpression(node) && /(^|\.)Schema$/.test(node.expression.getText(sf)) && node.arguments?.[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
      const name = assignedName(node, "");
      if (name) schemas.set(name, objectFields(sf, node.arguments[0], ownerFields, "ref"));
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
      const [a0, a1, a2] = node.arguments;
      // Mongoose: mongoose.model("Post", PostSchema)
      if (method === "model" && a0 && ts.isStringLiteralLike(a0) && a1 && ts.isIdentifier(a1) && schemas.has(a1.text)) {
        const s = schemas.get(a1.text)!;
        const accessor = assignedName(node, a0.text);
        out.push({ name: a0.text, accessor, dbName: a0.text.toLowerCase() + "s", fields: s.fields, ownerFields: s.owners, ownerRelations: [], file: rel, line: line(sf, node), source: "mongoose" });
      }
      // Sequelize: Post.init({...}, { sequelize, tableName })
      if (method === "init" && ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && a0 && ts.isObjectLiteralExpression(a0) && a1 && ts.isObjectLiteralExpression(a1) && /sequelize/.test(a1.getText(sf))) {
        const { fields, owners } = objectFields(sf, a0, ownerFields, null);
        const name = callee.expression.text;
        out.push({ name, accessor: name, dbName: objString(a1, ["tableName"]) ?? name + "s", fields, ownerFields: owners, ownerRelations: [], file: rel, line: line(sf, node), source: "sequelize" });
      }
      // Sequelize: const Post = sequelize.define("Post", {...}, { tableName })
      if (method === "define" && a0 && ts.isStringLiteralLike(a0) && a1 && ts.isObjectLiteralExpression(a1)) {
        const { fields, owners } = objectFields(sf, a1, ownerFields, null);
        out.push({ name: a0.text, accessor: assignedName(node, a0.text), dbName: objString(a2, ["tableName"]) ?? a0.text + "s", fields, ownerFields: owners, ownerRelations: [], file: rel, line: line(sf, node), source: "sequelize" });
      }
      // Sequelize: Post.belongsTo(models.User, { foreignKey: "ownerId" })
      if (method === "belongsTo" && ts.isPropertyAccessExpression(callee) && a0) {
        const model = targetName(callee.expression);
        const target = targetName(a0);
        if (model && target) {
          // foreignKey: "ownerId" or foreignKey: { name: "ownerId" }
          let fk: string | null = null;
          if (a1 && ts.isObjectLiteralExpression(a1)) {
            const p = a1.properties.find((q) => ts.isPropertyAssignment(q) && q.name.getText(sf) === "foreignKey");
            if (p && ts.isPropertyAssignment(p)) fk = ts.isStringLiteralLike(p.initializer) ? p.initializer.text : objString(p.initializer, ["name"]);
          }
          assoc.push({ model, target, foreignKey: fk });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const QUICK = /@Entity\(|@Schema\(|@Table\(|\.init\(|\.define\(|Schema\(|\.model\(|\bmodel\(|belongsTo\(/;

export function loadCodeModels(root: string, sourceFiles: string[], ownerFields: string[]): PrismaModel[] {
  const out: PrismaModel[] = [];
  const assoc: Association[] = [];
  for (const abs of sourceFiles) {
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (!QUICK.test(text) || !/typeorm|@mikro-orm|mongoose|sequelize|@nestjs\/mongoose|belongsTo/.test(text)) continue;
    const rel = toPosix(path.relative(root, abs));
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, /\.(m|c)?js$/.test(abs) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    out.push(...classModels(sf, rel, ownerFields), ...sequelizeAndMongoose(sf, rel, ownerFields, assoc));
  }
  // Sequelize belongsTo adds a foreign key such as UserId (or the foreignKey given)
  for (const a of assoc) {
    if (!OWNER_TARGET.test(a.target)) continue;
    const model = out.find((m) => m.accessor === a.model || m.name === a.model);
    if (!model) continue;
    for (const key of a.foreignKey ? [a.foreignKey] : [`${a.target}Id`, camel(`${a.target.charAt(0).toLowerCase()}${a.target.slice(1)}Id`)]) {
      if (!model.ownerFields.includes(key)) model.ownerFields.push(key);
    }
  }
  return out;
}

/** Tables created by SQL migrations, with their columns. */
export function sqlTables(files: { rel: string; text: string }[], ownerFields: string[]): PrismaModel[] {
  const tables = new Map<string, PrismaModel>();
  for (const { rel, text } of files) {
    for (const stmt of splitSql(text)) {
      const create = new RegExp(`^CREATE\\s+(?:UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})\\s*\\((.*)\\)`, "i").exec(stmt.text);
      if (create) {
        const name = unquoteIdent(create[1]);
        const fields: PrismaField[] = [];
        for (const part of splitTopLevel(create[2])) {
          const c = new RegExp(`^(${IDENT})\\s`).exec(part);
          if (c && !/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE|LIKE)\b/i.test(part)) fields.push(field(camel(unquoteIdent(c[1])), unquoteIdent(c[1]), "column", stmt.line));
        }
        tables.set(name, { name, accessor: name, dbName: name, fields, ownerFields: [], ownerRelations: [], file: rel, line: stmt.line, source: "sql" });
        continue;
      }
      const add = new RegExp(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${IDENT})\\s+(.*)$`, "i").exec(stmt.text);
      if (add && tables.has(unquoteIdent(add[1]))) {
        const t = tables.get(unquoteIdent(add[1]))!;
        for (const action of splitTopLevel(add[2])) {
          const col = new RegExp(`^ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})\\s`, "i").exec(action);
          if (col && !/^ADD\s+(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)\b/i.test(action)) t.fields.push(field(camel(unquoteIdent(col[1])), unquoteIdent(col[1]), "column", stmt.line));
        }
      }
      const drop = new RegExp(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT})`, "i").exec(stmt.text);
      if (drop) tables.delete(unquoteIdent(drop[1]));
    }
  }
  for (const t of tables.values()) t.ownerFields = t.fields.filter((f) => isOwnerName(f.dbName, ownerFields)).map((f) => f.name);
  return [...tables.values()];
}
