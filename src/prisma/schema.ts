import * as fs from "fs";
import * as path from "path";

export interface PrismaField {
  name: string;
  /** Column name in the database (from @map, else the field name) */
  dbName: string;
  type: string;
  optional: boolean;
  list: boolean;
  /** True when the type is another model (a relation field, not a column) */
  isRelation: boolean;
  /** For relation fields: the scalar fields listed in @relation(fields: [...]) */
  relationFields: string[];
  line: number;
}

export interface PrismaModel {
  name: string;
  /** Prisma Client accessor, e.g. "userProfile" for model UserProfile */
  accessor: string;
  /** Table name in the database (from @@map, else the model name) */
  dbName: string;
  fields: PrismaField[];
  /** Scalar fields that tie a row to a user/tenant (from config.ownerFields) */
  ownerFields: string[];
  /** Relation fields backed by an owner field, e.g. "author" for authorId */
  ownerRelations: string[];
  file: string;
  line: number;
}

export interface PrismaSchema {
  models: PrismaModel[];
  files: string[];
  byAccessor: Map<string, PrismaModel>;
  byTable: Map<string, PrismaModel>;
}

const SCALARS = new Set(["String", "Int", "BigInt", "Float", "Decimal", "Boolean", "DateTime", "Json", "Bytes", "Unsupported"]);

export function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Finds schema.prisma (single file) or prisma/schema/*.prisma (multi-file). Returns absolute paths. */
export function findSchemaFiles(root: string, explicit: string): string[] {
  if (explicit) {
    const p = path.resolve(root, explicit);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      return fs.readdirSync(p).filter((f) => f.endsWith(".prisma")).map((f) => path.join(p, f)).sort();
    }
    return fs.existsSync(p) ? [p] : [];
  }
  // package.json "prisma": { "schema": "..." }
  const pkgPath = path.join(root, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      // The path comes from the scanned project itself, so it must stay inside the project.
      const rel = pkg.prisma && typeof pkg.prisma.schema === "string" ? path.relative(root, path.resolve(root, pkg.prisma.schema)) : null;
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        return findSchemaFiles(root, rel);
      }
    } catch {
      /* ignore broken package.json */
    }
  }
  const candidates = ["prisma/schema.prisma", "schema.prisma", "prisma/schema"];
  for (const c of candidates) {
    const found = findSchemaFiles(root, c);
    if (found.length) return found;
  }
  // Monorepos: search the tree (e.g. packages/db/prisma/schema.prisma). Shallowest match wins.
  const hits: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && e.name === "schema.prisma") hits.push(path.join(dir, e.name));
      else if (e.isDirectory() && !["node_modules", ".git", ".next", "dist", "build"].includes(e.name)) visit(path.join(dir, e.name), depth + 1);
    }
  };
  visit(root, 0);
  hits.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
  return hits.length ? [hits[0]] : [];
}

export function parseSchemaText(text: string, file: string, ownerFieldNames: string[]): PrismaModel[] {
  const models: PrismaModel[] = [];
  const lines = text.split("\n");
  let current: PrismaModel | null = null;
  let depth = 0;

  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) return;

    if (!current) {
      const m = /^model\s+(\w+)\s*\{/.exec(line);
      if (m) {
        current = { name: m[1], accessor: lowerFirst(m[1]), dbName: m[1], fields: [], ownerFields: [], ownerRelations: [], file, line: lineNo };
        depth = 1;
      }
      return;
    }

    if (line.startsWith("}")) {
      depth--;
      if (depth === 0) {
        models.push(current);
        current = null;
      }
      return;
    }

    if (line.startsWith("@@")) {
      const map = /^@@map\(\s*(?:name\s*:\s*)?"([^"]+)"/.exec(line);
      if (map) current.dbName = map[1];
      return;
    }

    const f = /^(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/.exec(line);
    if (!f) return;
    const [, name, type, list, optional, rest] = f;
    const mapAttr = /@map\(\s*(?:name\s*:\s*)?"([^"]+)"/.exec(rest);
    const relAttr = /@relation\(([^)]*)\)/.exec(rest);
    let relationFields: string[] = [];
    if (relAttr) {
      const fm = /fields\s*:\s*\[([^\]]*)\]/.exec(relAttr[1]);
      if (fm) relationFields = fm[1].split(",").map((s) => s.trim()).filter(Boolean);
    }
    current.fields.push({
      name,
      dbName: mapAttr ? mapAttr[1] : name,
      type,
      optional: Boolean(optional),
      list: Boolean(list),
      isRelation: false, // resolved after all models are known
      relationFields,
      line: lineNo
    });
  });

  // Mark owner fields (scalar columns only)
  for (const model of models) {
    for (const field of model.fields) {
      if (ownerFieldNames.includes(field.name) && SCALARS.has(field.type)) model.ownerFields.push(field.name);
    }
  }
  return models;
}

export function loadSchema(root: string, explicit: string, ownerFieldNames: string[]): PrismaSchema | null {
  const files = findSchemaFiles(root, explicit);
  if (!files.length) return null;
  const models: PrismaModel[] = [];
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    models.push(...parseSchemaText(fs.readFileSync(file, "utf8"), rel, ownerFieldNames));
  }
  return buildSchema(models, files);
}

export function buildSchema(models: PrismaModel[], files: string[] = []): PrismaSchema {
  const modelNames = new Set(models.map((m) => m.name));
  for (const model of models) {
    for (const field of model.fields) {
      field.isRelation = modelNames.has(field.type);
      if (field.isRelation && field.relationFields.some((rf) => model.ownerFields.includes(rf))) {
        model.ownerRelations.push(field.name);
      }
    }
  }
  return {
    models,
    files,
    byAccessor: new Map(models.map((m) => [m.accessor, m])),
    byTable: new Map(models.map((m) => [m.dbName, m]))
  };
}
