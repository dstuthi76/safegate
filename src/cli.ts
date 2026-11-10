#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { CONFIG_FILE, DEFAULT_CONFIG } from "./config";
import { applyProposal, createWorkspace, FIXABLE_RULES, FixProposal, proposalsToMarkdown, proposeFix } from "./ai/fix";
import { geminiConfigFromEnv } from "./ai/gemini";
import { run, VERSION } from "./index";
import { ALL_RULES, format, Format } from "./report/report";
import { startServer } from "./server/server";
import { SEVERITY_RANK, Severity } from "./types";

const HELP = `safegate ${VERSION} - catch auth bugs and unsafe migrations in Next.js/Express + Prisma apps

Usage:
  safegate check [options]     scan a project
  safegate fix [options]       ask Gemini for patches and verify each one by re-scanning
  safegate serve               start the web app (used on Cloud Run)
  safegate rules               list all rules
  safegate init                write a starter ${CONFIG_FILE}

Options for check:
  --root <dir>          project root (default: current directory)
  --format <fmt>        text | json | sarif | github | markdown (default: text)
  --output <file>       write the report to a file instead of stdout
  --fail-on <level>     high | medium | low | none (default: high)
  --only <part>         auth | migrations
  --base <git-ref>      only report findings in files changed since <git-ref> (for PRs)
  --no-color            disable colors

Options for fix (needs GEMINI_API_KEY, or Vertex AI on Google Cloud):
  --root, --only, --base   as for check
  --rule <id>           only fix this rule, e.g. AUTH003
  --max <n>             fix at most n findings (default 10)
  --apply               write verified patches into your files
  --format <fmt>        text | markdown | json (default: text)
  --output <file>       write the report to a file

Exit codes: 0 = no findings at/above --fail-on, 1 = findings, 2 = usage or runtime error`;

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--no-")) args[a.slice(5)] = false;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const eq = key.indexOf("=");
      if (eq >= 0) args[key.slice(0, eq)] = key.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) args[key] = argv[++i];
      else args[key] = true;
    } else positional.push(a);
  }
  return { args, positional };
}

async function main(): Promise<number> {
  const { args, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];

  if (!cmd || args.help || cmd === "help") {
    console.log(HELP);
    return cmd ? 0 : 2;
  }
  if (args.version || cmd === "version") {
    console.log(VERSION);
    return 0;
  }
  if (cmd === "rules") {
    for (const r of ALL_RULES) console.log(`${r.id.padEnd(8)} ${r.severity.padEnd(7)} ${r.name.padEnd(34)} ${r.description}`);
    return 0;
  }
  if (cmd === "init") {
    const root = path.resolve(String(args.root ?? "."));
    const file = path.join(root, CONFIG_FILE);
    if (fs.existsSync(file)) {
      console.error(`${CONFIG_FILE} already exists`);
      return 2;
    }
    const starter = {
      publicRoutes: ["**/api/og/**"],
      ownerFields: [],
      authFunctions: [],
      disabledRules: []
    };
    fs.writeFileSync(file, JSON.stringify(starter, null, 2) + "\n");
    console.log(`Wrote ${file}. Arrays extend the defaults; see README for every option. Defaults:\n${JSON.stringify(DEFAULT_CONFIG, null, 2)}`);
    return 0;
  }
  if (cmd === "serve") {
    await startServer(Number(args.port ?? process.env.PORT ?? 8080));
    return await new Promise<number>(() => {});
  }
  if (cmd === "fix") return fixCommand(args);
  if (cmd !== "check") {
    console.error(`Unknown command "${cmd}".\n\n${HELP}`);
    return 2;
  }

  const fmt = String(args.format ?? "text") as Format;
  if (!["text", "json", "sarif", "github", "markdown"].includes(fmt)) {
    console.error(`--format must be text, json, sarif, github or markdown`);
    return 2;
  }
  const failOn = String(args["fail-on"] ?? "high");
  if (!["high", "medium", "low", "none"].includes(failOn)) {
    console.error(`--fail-on must be high, medium, low or none`);
    return 2;
  }
  const only = args.only ? String(args.only) : null;
  if (only && only !== "auth" && only !== "migrations") {
    console.error(`--only must be auth or migrations`);
    return 2;
  }

  const summary = run({
    root: String(args.root ?? "."),
    only: only as "auth" | "migrations" | null,
    base: args.base ? String(args.base) : null
  });

  const color = args.color !== false && !args.output && process.stdout.isTTY === true && fmt === "text";
  const out = format(summary, fmt, color);
  if (args.output) fs.writeFileSync(String(args.output), out + "\n");
  else console.log(out);

  if (failOn === "none") return 0;
  const threshold = SEVERITY_RANK[failOn as Severity];
  return summary.findings.some((f) => SEVERITY_RANK[f.severity] >= threshold) ? 1 : 0;
}

async function fixCommand(args: Record<string, string | boolean>): Promise<number> {
  const cfg = geminiConfigFromEnv();
  if (!cfg) {
    console.error("safegate fix needs Gemini. Set GEMINI_API_KEY (free key from https://aistudio.google.com/apikey), or on Google Cloud set GOOGLE_CLOUD_PROJECT and GOOGLE_GENAI_USE_VERTEXAI=true.");
    return 2;
  }
  const fmt = String(args.format ?? "text");
  if (!["text", "markdown", "json"].includes(fmt)) {
    console.error("--format must be text, markdown or json");
    return 2;
  }
  const root = path.resolve(String(args.root ?? "."));
  const only = args.only ? (String(args.only) as "auth" | "migrations") : null;
  const max = Math.max(1, Number(args.max ?? 10) || 10);
  const log = (m: string) => (fmt === "text" ? console.log(m) : console.error(m));

  const reported = run({ root, only, base: args.base ? String(args.base) : null }).findings;
  const targets = reported.filter((f) => FIXABLE_RULES.has(f.ruleId) && (!args.rule || f.ruleId === String(args.rule))).slice(0, max);
  log(`safegate ${VERSION}: ${reported.length} findings, asking Gemini (${cfg.models[0]}) to fix ${targets.length}`);

  const ws = createWorkspace(root);
  const proposals: FixProposal[] = [];
  try {
    for (const t of targets) {
      // Fresh baseline each time: with --apply, earlier patches stay in the workspace.
      const baseline = run({ root: ws.dir }).findings;
      const current = baseline.filter((f) => f.ruleId === t.ruleId && f.file === t.file).sort((a, b) => Math.abs(a.line - t.line) - Math.abs(b.line - t.line))[0];
      if (!current) continue; // already fixed by an earlier patch
      const p = await proposeFix(ws.dir, current, baseline, cfg, { keep: args.apply === true });
      proposals.push(p);
      if (p.status === "verified" && args.apply === true) applyProposal(root, p);
      log(`\n${p.status === "verified" ? "VERIFIED" : p.status.toUpperCase()}  ${t.ruleId}  ${t.file}:${t.line}  (attempts: ${p.attempts})`);
      if (p.status === "verified") log(`${p.explanation}\nIf left unfixed: ${p.impact}\n\n${p.diff}`);
      else log(`  ${p.reason ?? ""}`);
    }
  } finally {
    ws.dispose();
  }
  const ok = proposals.filter((p) => p.status === "verified").length;
  log(`\n${ok} of ${proposals.length} fixes verified${args.apply === true ? " and applied" : ". Re-run with --apply to write them"}.`);

  const report = fmt === "markdown" ? proposalsToMarkdown(proposals) : fmt === "json" ? JSON.stringify(proposals, null, 2) : null;
  if (report !== null) {
    if (args.output) fs.writeFileSync(String(args.output), report + "\n");
    else console.log(report);
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(`safegate: ${(e as Error).message}`);
    process.exitCode = 2;
  }
);
