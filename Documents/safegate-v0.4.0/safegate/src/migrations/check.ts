import * as fs from "fs";
import * as path from "path";
import { Finding } from "../types";
import { toPosix } from "../util/files";
import { analyzeStatements, DroppedColumn } from "./rules";
import { splitSql } from "./sql";

/** Per-migration files inside a folder layout: Prisma (migration.sql), Diesel and others (up.sql). */
const UP_FILES = ["migration.sql", "up.sql"];

/** Rollback or undo scripts, which never run on deploy: 0001_x.down.sql, down.sql, Flyway U1__x.sql */
export function isRollback(name: string): boolean {
  return /[._-]down\.sql$/i.test(name) || /^down\.sql$/i.test(name) || /^U\d[\w.]*__.*\.sql$/.test(name);
}

/** Migration text that runs on deploy. dbmate keeps the rollback in the same file after "-- migrate:down". */
export function readMigrationSql(abs: string): string {
  const text = fs.readFileSync(abs, "utf8");
  const down = /^[ \t]*--[ \t]*migrate:down\b/m.exec(text);
  return down ? text.slice(0, down.index) : text;
}

function sqlInDir(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      const up = UP_FILES.map((u) => path.join(dir, e.name, u)).find((f) => fs.existsSync(f));
      if (up) files.push(up);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".sql") && !isRollback(e.name)) {
      files.push(path.join(dir, e.name));
    }
  }
  return files;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "out", "coverage", "vendor", "test", "tests", "__tests__", "fixtures", "__fixtures__", ".turbo", ".venv", "target"]);

/**
 * Returns migration SQL files in apply order (absolute paths). Knows the layouts of Prisma, Drizzle Kit,
 * Supabase, Flyway, golang-migrate, dbmate, Diesel and plain folders of .sql files.
 */
export function findMigrationFiles(root: string, explicitDir: string, schemaFiles: string[]): string[] {
  const candidates: string[] = [];
  if (explicitDir) candidates.push(path.resolve(root, explicitDir));
  if (schemaFiles.length) {
    const schemaDir = path.dirname(schemaFiles[0]);
    candidates.push(path.join(schemaDir, "migrations"), path.join(path.dirname(schemaDir), "migrations"));
  }
  for (const rel of ["prisma/migrations", "migrations", "drizzle", "supabase/migrations", "db/migrations", "db/migration", "src/main/resources/db/migration", "sql/migrations", "migrations/sql", "src/db/migrations", "src/drizzle"]) {
    candidates.push(path.join(root, rel));
  }
  for (const dir of candidates) {
    const files = sqlInDir(dir);
    if (files.length) return files;
  }

  // Anywhere else in the tree: the shallowest folder named migrations, migration or drizzle that holds SQL.
  let queue: string[] = [root];
  for (let depth = 0; depth <= 6 && queue.length; depth++) {
    const next: string[] = [];
    for (const dir of queue.sort()) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries.filter((x) => x.isDirectory() && !SKIP_DIRS.has(x.name) && !x.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name))) {
        const abs = path.join(dir, e.name);
        if (/^(migrations?|drizzle)$/i.test(e.name)) {
          const files = sqlInDir(abs);
          if (files.length) return files;
        }
        next.push(abs);
      }
    }
    queue = next;
  }
  return [];
}

export interface MigrationCheckResult {
  findings: Finding[];
  droppedColumns: DroppedColumn[];
  filesChecked: string[];
}

/**
 * @param onlyFiles when set (relative paths), only these migrations are analyzed, and
 *   tables created in one of them count as new for the later ones (they ship together).
 */
export function checkMigrations(root: string, files: string[], onlyFiles?: Set<string>): MigrationCheckResult {
  const findings: Finding[] = [];
  const droppedColumns: DroppedColumn[] = [];
  const filesChecked: string[] = [];
  const shared = new Set<string>();

  for (const abs of files) {
    const rel = toPosix(path.relative(root, abs));
    if (onlyFiles && !onlyFiles.has(rel)) continue;
    filesChecked.push(rel);
    const statements = splitSql(readMigrationSql(abs));
    const newTables = onlyFiles ? shared : new Set<string>();
    const result = analyzeStatements(statements, { file: rel, newTables });
    findings.push(...result.findings);
    droppedColumns.push(...result.droppedColumns);
  }
  return { findings, droppedColumns, filesChecked };
}
