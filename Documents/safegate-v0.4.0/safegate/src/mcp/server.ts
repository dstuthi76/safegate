import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { applyProposal, createWorkspace, FIXABLE_RULES, FixProposal, isFixable, proposeFix } from "../ai/fix";
import { geminiConfigFromEnv } from "../ai/gemini";
import { run, VERSION } from "../index";
import { ALL_RULES, sortFindings } from "../report/report";
import { Finding, SEVERITY_RANK, Severity } from "../types";
import { toPosix } from "../util/files";

/**
 * safegate as an MCP server over stdio (newline-delimited JSON-RPC 2.0).
 * Any MCP client (Claude Code, Claude Desktop, Gemini CLI, Cursor, Antigravity...) starts it
 * with `node dist/src/cli.js mcp`. It runs on the developer's machine, so private code never
 * leaves it; only safegate_fix sends the one affected file and the schema to Gemini.
 */

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const FALLBACK_PROTOCOL = "2025-06-18";
const MAX_FINDINGS = 200;

const INSTRUCTIONS =
  "safegate checks TypeScript/JavaScript projects (Next.js, NestJS, Express, Hono, Fastify, tRPC, GraphQL, Remix, SvelteKit, Nuxt, Astro; Prisma, Drizzle, TypeORM, Sequelize, Mongoose, Kysely, Knex) for access-control bugs, and Postgres migrations (SQL, Rails, Django, Alembic, Laravel, Knex, Sequelize, TypeORM, node-pg-migrate) for locks and data loss. " +
  "Run safegate_scan after changing API routes, server actions, tRPC procedures, database queries, schema files or migrations, and fix every high finding in code you changed. " +
  "safegate_fix asks Gemini for patches and returns only the ones that pass a re-scan (needs GEMINI_API_KEY or Vertex AI).";

const pathProp = { type: "string", description: "Project root to check. Absolute, or relative to the folder the server was started in. Defaults to that folder." };

export const TOOLS = [
  {
    name: "safegate_scan",
    title: "Scan a project with safegate",
    description:
      "Finds access-control bugs (missing auth, IDOR, mass assignment, admin without role check) and unsafe Postgres migrations. Deterministic: the same code always gives the same result. Returns findings with file, line, problem and a suggested fix.",
    inputSchema: {
      type: "object",
      properties: {
        path: pathProp,
        only: { type: "string", enum: ["auth", "migrations"], description: "Run only one checker." },
        base: { type: "string", description: "Git ref (e.g. origin/main): report only findings in files changed since it." },
        files: { type: "array", items: { type: "string" }, description: "Report only findings in these files (paths relative to the project root)." },
        min_severity: { type: "string", enum: ["high", "medium", "low"], description: "Lowest severity to report. Default: low." }
      }
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: "safegate_fix",
    title: "Get verified fixes from Gemini",
    description:
      "For each fixable finding, asks Gemini for a patch, applies it to a scratch copy and re-scans. Returns only patches that remove the finding and add no new one, as diffs. With apply=true, writes the verified patches into the project.",
    inputSchema: {
      type: "object",
      properties: {
        path: pathProp,
        rule: { type: "string", description: "Only fix this rule, e.g. AUTH003." },
        file: { type: "string", description: "Only fix findings in this file (relative to the project root)." },
        line: { type: "integer", description: "With file: only the finding on this line." },
        max: { type: "integer", minimum: 1, maximum: 10, description: "Fix at most this many findings. Default 3." },
        apply: { type: "boolean", description: "Write verified patches into the files. Default false (show diffs only)." }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  },
  {
    name: "safegate_rules",
    title: "List safegate rules",
    description: "Lists every rule with its id, severity and what it catches.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }
];

class ToolError extends Error {}

function resolveRoot(cwd: string, p: unknown): string {
  const root = path.resolve(cwd, typeof p === "string" && p.trim() ? p.trim() : ".");
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new ToolError(`Not a folder: ${root}`);
  return root;
}

function relTo(root: string, file: string): string {
  return toPosix(path.isAbsolute(file) ? path.relative(root, file) : path.normalize(file)).replace(/^\.\//, "");
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function scanTool(cwd: string, args: Record<string, unknown>): string {
  const root = resolveRoot(cwd, args.path);
  const only = args.only === "auth" || args.only === "migrations" ? args.only : null;
  const summary = run({ root, only, base: str(args.base) });
  let findings: Finding[] = summary.findings;
  if (Array.isArray(args.files) && args.files.length) {
    const wanted = new Set(args.files.filter((f): f is string => typeof f === "string").map((f) => relTo(root, f)));
    findings = findings.filter((f) => wanted.has(f.file));
  }
  const min = SEVERITY_RANK[(args.min_severity as Severity) ?? "low"] ?? 1;
  findings = sortFindings(findings.filter((f) => SEVERITY_RANK[f.severity] >= min));
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  return JSON.stringify(
    {
      root,
      checked: { endpoints: summary.entriesChecked, migrations: summary.migrationsChecked, schemaFound: summary.schemaFound },
      total: findings.length,
      counts,
      truncated: findings.length > MAX_FINDINGS,
      findings: findings.slice(0, MAX_FINDINGS).map((f) => ({ ruleId: f.ruleId, severity: f.severity, file: f.file, line: f.line, problem: f.message, fix: f.fix, autoFixable: isFixable(f) }))
    },
    null,
    2
  );
}

async function fixTool(cwd: string, args: Record<string, unknown>): Promise<string> {
  const cfg = geminiConfigFromEnv();
  if (!cfg) throw new ToolError("Gemini is not configured. Set GEMINI_API_KEY in this server's environment (free key at https://aistudio.google.com/apikey), or GOOGLE_CLOUD_PROJECT with GOOGLE_GENAI_USE_VERTEXAI=true.");
  const root = resolveRoot(cwd, args.path);
  const rule = str(args.rule);
  const file = str(args.file) ? relTo(root, String(args.file)) : null;
  const line = typeof args.line === "number" ? args.line : null;
  const max = Math.min(10, Math.max(1, typeof args.max === "number" ? Math.floor(args.max) : 3));
  const apply = args.apply === true;

  const targets = run({ root })
    .findings.filter((f) => isFixable(f) && (!rule || f.ruleId === rule) && (!file || f.file === file) && (line === null || f.line === line))
    .slice(0, max);
  if (!targets.length) return "No fixable findings match. Run safegate_scan to see what was found.";

  const ws = createWorkspace(root);
  const proposals: FixProposal[] = [];
  try {
    for (const t of targets) {
      const baseline = run({ root: ws.dir }).findings;
      const current = baseline.filter((f) => f.ruleId === t.ruleId && f.file === t.file).sort((a, b) => Math.abs(a.line - t.line) - Math.abs(b.line - t.line))[0];
      if (!current) continue;
      const p = await proposeFix(ws.dir, current, baseline, cfg, { keep: apply });
      if (p.status === "verified" && apply) applyProposal(root, p);
      proposals.push(p);
    }
  } finally {
    ws.dispose();
  }
  const verified = proposals.filter((p) => p.status === "verified").length;
  const parts = [`${verified} of ${proposals.length} fixes verified by re-scan${apply ? " and written to the project" : " (not applied; call again with apply=true to write them)"}.`];
  for (const p of proposals) {
    const loc = `${p.finding.ruleId} ${p.finding.file}:${p.finding.line}`;
    if (p.status === "verified") parts.push(`\n## VERIFIED ${loc}\n${p.explanation}\nIf left unfixed: ${p.impact}\n\n\`\`\`diff\n${p.diff}\n\`\`\``);
    else parts.push(`\n## ${p.status.toUpperCase()} ${loc}\n${p.reason ?? ""}\nManual fix: ${p.finding.fix}`);
  }
  return parts.join("\n");
}

function rulesTool(): string {
  return ALL_RULES.map((r) => `${r.id} (${r.severity}) ${r.name}: ${r.description}${FIXABLE_RULES.has(r.id) ? "" : " [no automatic fix]"}`).join("\n");
}

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export async function handleMessage(msg: RpcMessage, cwd: string): Promise<object | null> {
  const isRequest = msg.id !== undefined && msg.id !== null;
  const reply = (result: object) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (typeof msg.method !== "string") return isRequest ? fail(-32600, "Invalid request") : null;
  if (!isRequest) return null; // notifications (initialized, cancelled...) need no reply

  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      const protocolVersion = typeof asked === "string" && PROTOCOLS.includes(asked) ? asked : FALLBACK_PROTOCOL;
      return reply({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "safegate", title: "safegate", version: VERSION }, instructions: INSTRUCTIONS });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = msg.params?.name;
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${String(name)}`);
      try {
        const text = name === "safegate_scan" ? scanTool(cwd, args) : name === "safegate_fix" ? await fixTool(cwd, args) : rulesTool();
        return reply({ content: [{ type: "text", text }], isError: false });
      } catch (e) {
        return reply({ content: [{ type: "text", text: `safegate: ${(e as Error).message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

/** Runs the stdio server until stdin closes. Logs go to stderr; stdout carries only protocol messages. */
export function startMcp(cwd = process.cwd()): Promise<void> {
  const write = (o: object | null) => {
    if (o) process.stdout.write(JSON.stringify(o) + "\n");
  };
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const job = (async () => {
      if (Array.isArray(parsed)) {
        const out = (await Promise.all(parsed.map((m) => handleMessage(m as RpcMessage, cwd)))).filter(Boolean);
        if (out.length) write(out as object);
      } else {
        write(await handleMessage(parsed as RpcMessage, cwd));
      }
    })().catch((e) => {
      process.stderr.write(`safegate mcp: ${(e as Error).message}\n`);
    });
    pending.add(job);
    job.finally(() => pending.delete(job));
  });
  process.stderr.write(`safegate ${VERSION} MCP server ready (Gemini: ${geminiConfigFromEnv() ? "configured" : "not configured"})\n`);
  return new Promise((resolve) => rl.on("close", () => Promise.all([...pending]).then(() => resolve())));
}
