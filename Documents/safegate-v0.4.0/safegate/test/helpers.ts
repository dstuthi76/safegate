import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { run } from "../src/index";
import { Finding } from "../src/types";

export const BASE_SCHEMA = `
model User {
  id      String  @id
  email   String  @unique
  role    String  @default("USER")
  posts   Post[]
}

model Post {
  id        String  @id
  title     String
  published Boolean @default(false)
  authorId  String
  author    User    @relation(fields: [authorId], references: [id])
}

model Tag {
  id   String @id
  name String
}
`;

/** Writes files into a fresh temp project and runs safegate on it. */
export function scan(files: Record<string, string>, opts: { only?: "auth" | "migrations" } = {}): Finding[] {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safegate-test-"));
  const all = { "prisma/schema.prisma": BASE_SCHEMA, ...files };
  for (const [rel, content] of Object.entries(all)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  try {
    return run({ root, only: opts.only ?? null }).findings;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function ids(findings: Finding[]): string[] {
  return findings.map((f) => f.ruleId).sort();
}

/** Runs one migration on top of an init migration that created the tables in an earlier release. */
export function scanMigration(sql: string): Finding[] {
  return scan(
    {
      "prisma/migrations/001_init/migration.sql": `CREATE TABLE "Post" ("id" TEXT NOT NULL, "title" TEXT, "authorId" TEXT NOT NULL, "views" INTEGER);\nCREATE TABLE "User" ("id" TEXT NOT NULL, "bio" TEXT);`,
      "prisma/migrations/002_change/migration.sql": sql
    },
    { only: "migrations" }
  ).filter((f) => f.file.includes("002_change"));
}
