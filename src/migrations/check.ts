import * as fs from "fs";
import * as path from "path";
import { Finding } from "../types";
import { toPosix } from "../util/files";
import { analyzeStatements, DroppedColumn } from "./rules";
import { splitSql } from "./sql";

/** Returns migration SQL files in apply order (absolute paths). */
export function findMigrationFiles(root: string, explicitDir: string, schemaFiles: string[]): string[] {
  const candidates: string[] = [];
  if (explicitDir) candidates.push(path.resolve(root, explicitDir));
  if (schemaFiles.length) {
    const schemaDir = path.dirname(schemaFiles[0]);
    candidates.push(path.join(schemaDir, "migrations"), path.join(path.dirname(schemaDir), "migrations"));
  }
  candidates.push(path.join(root, "prisma", "migrations"), path.join(root, "migrations"));

  for (const dir of candidates) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    const files: string[] = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        const f = path.join(dir, e.name, "migration.sql");
        if (fs.existsSync(f)) files.push(f);
      } else if (e.isFile() && e.name.endsWith(".sql")) {
        files.push(path.join(dir, e.name));
      }
    }
    if (files.length) return files;
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
    const statements = splitSql(fs.readFileSync(abs, "utf8"));
    const newTables = onlyFiles ? shared : new Set<string>();
    const result = analyzeStatements(statements, { file: rel, newTables });
    findings.push(...result.findings);
    droppedColumns.push(...result.droppedColumns);
  }
  return { findings, droppedColumns, filesChecked };
}
