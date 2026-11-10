import * as path from "path";
import { checkAuth, SOURCE_EXTS } from "./auth/check";
import { loadConfig, SafegateConfig } from "./config";
import { crossCheckDroppedColumns } from "./crosscheck/dropped-columns";
import { changedFiles } from "./git";
import { checkMigrations, findMigrationFiles } from "./migrations/check";
import { loadSchema } from "./prisma/schema";
import { RunSummary } from "./report/report";
import { Finding } from "./types";
import { toPosix, walk } from "./util/files";
import { applySuppressions } from "./util/suppress";

export const VERSION = "0.2.0";

export interface RunOptions {
  root: string;
  only?: "auth" | "migrations" | null;
  /** git ref: only report findings in files changed since this ref */
  base?: string | null;
  config?: SafegateConfig;
}

export function run(opts: RunOptions): RunSummary {
  const root = path.resolve(opts.root);
  const config = opts.config ?? loadConfig(root);
  const schema = loadSchema(root, config.schemaPath, config.ownerFields);
  const changed = opts.base ? changedFiles(root, opts.base) : null;

  const sourceFiles = walk(root, SOURCE_EXTS, config.ignore);
  const findings: Finding[] = [];
  let migrationsChecked = 0;
  let entriesChecked = 0;

  if (opts.only !== "auth") {
    const migFiles = findMigrationFiles(root, config.migrationsDir, schema?.files ?? []);
    const onlyMigs = changed ? new Set([...changed].filter((f) => migFiles.some((m) => toPosix(path.relative(root, m)) === f))) : undefined;
    const mig = checkMigrations(root, migFiles, onlyMigs);
    migrationsChecked = mig.filesChecked.length;
    findings.push(...mig.findings);
    findings.push(...crossCheckDroppedColumns(root, mig.droppedColumns, migFiles, schema, sourceFiles));
  }

  if (opts.only !== "migrations") {
    const files = changed ? sourceFiles.filter((f) => changed.has(toPosix(path.relative(root, f)))) : sourceFiles;
    const auth = checkAuth(root, files, config, schema);
    entriesChecked = auth.entriesChecked;
    findings.push(...auth.findings);
  }

  const enabled = findings.filter((f) => !config.disabledRules.includes(f.ruleId));
  return {
    root,
    findings: applySuppressions(root, enabled),
    migrationsChecked,
    entriesChecked,
    schemaFound: !!schema,
    version: VERSION
  };
}

export { loadConfig } from "./config";
export type { Finding, Severity } from "./types";
