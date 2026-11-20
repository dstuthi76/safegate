import * as path from "path";
import { checkAuth, SOURCE_EXTS } from "./auth/check";
import { loadConfig, SafegateConfig } from "./config";
import { crossCheckDroppedColumns } from "./crosscheck/dropped-columns";
import { changedFiles } from "./git";
import { checkMigrations, findMigrationFiles, readMigrationSql } from "./migrations/check";
import { checkCodeMigrations, findCodeMigrations, knexTables } from "./migrations/code";
import { loadCodeModels, sqlTables } from "./orm/models";
import { loadDrizzleModels } from "./drizzle/schema";
import { buildSchema, loadPrismaModels } from "./prisma/schema";
import { RunSummary } from "./report/report";
import { Finding } from "./types";
import { toPosix, walk } from "./util/files";
import { applySuppressions } from "./util/suppress";

export const VERSION = "0.4.0";

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
  const changed = opts.base ? changedFiles(root, opts.base) : null;
  const sourceFiles = walk(root, SOURCE_EXTS, config.ignore);

  // Data model: Prisma schema files and/or Drizzle table definitions
  // Data model: Prisma schema files, Drizzle tables, TypeORM/MikroORM/Sequelize/Mongoose models,
  // then tables created by SQL or Knex migrations that no ORM model covers (for Knex, Kysely and raw queries)
  const prisma = loadPrismaModels(root, config.schemaPath, config.ownerFields);
  const codeMigrations = findCodeMigrations(root, config.ignore);
  const codeMigrationRels = new Set(codeMigrations.map((m) => m.rel));
  const appFiles = sourceFiles.filter((f) => !codeMigrationRels.has(toPosix(path.relative(root, f))));
  const models = [...prisma.models, ...loadDrizzleModels(root, appFiles, config.ownerFields), ...loadCodeModels(root, appFiles, config.ownerFields)];
  const migFiles = findMigrationFiles(root, config.migrationsDir, prisma.files);
  const known = new Set(models.map((m) => m.dbName.toLowerCase()));
  const sqlFiles = migFiles.map((abs) => ({ rel: toPosix(path.relative(root, abs)), text: readMigrationSql(abs) }));
  for (const t of [...sqlTables(sqlFiles, config.ownerFields), ...knexTables(codeMigrations, config.ownerFields)]) {
    if (known.has(t.dbName.toLowerCase())) continue;
    known.add(t.dbName.toLowerCase());
    models.push(t);
  }
  const schema = models.length || prisma.files.length ? buildSchema(models, prisma.files) : null;
  const findings: Finding[] = [];
  let migrationsChecked = 0;
  let entriesChecked = 0;

  if (opts.only !== "auth") {
    const onlyMigs = changed ? new Set([...changed].filter((f) => migFiles.some((m) => toPosix(path.relative(root, m)) === f))) : undefined;
    const mig = checkMigrations(root, migFiles, onlyMigs);
    const code = checkCodeMigrations(root, codeMigrations, changed ? new Set([...changed].filter((f) => codeMigrationRels.has(f))) : undefined);
    migrationsChecked = mig.filesChecked.length + code.filesChecked.length;
    findings.push(...mig.findings, ...code.findings);
    findings.push(...crossCheckDroppedColumns(root, [...mig.droppedColumns, ...code.droppedColumns], migFiles, schema, appFiles));
  }

  if (opts.only !== "migrations") {
    const files = changed ? appFiles.filter((f) => changed.has(toPosix(path.relative(root, f)))) : appFiles;
    const auth = checkAuth(root, files, config, schema, appFiles);
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
