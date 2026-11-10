import { AUTH_RULES } from "../auth/analyze";
import { MIGRATION_RULES } from "../migrations/rules";
import { Finding, RuleMeta, SEVERITY_RANK } from "../types";

export const ALL_RULES: RuleMeta[] = [
  ...AUTH_RULES,
  ...MIGRATION_RULES,
  { id: "XCHK001", name: "dropped-column-still-used", severity: "high", description: "A column dropped by a migration is still used by application code or declared in schema.prisma." }
];

export type Format = "text" | "json" | "sarif" | "github" | "markdown";

export interface RunSummary {
  root: string;
  findings: Finding[];
  migrationsChecked: number;
  entriesChecked: number;
  schemaFound: boolean;
  version: string;
}

export function sortFindings(f: Finding[]): Finding[] {
  return [...f].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.file.localeCompare(b.file) || a.line - b.line || a.ruleId.localeCompare(b.ruleId));
}

function counts(f: Finding[]): string {
  const c = { high: 0, medium: 0, low: 0 };
  for (const x of f) c[x.severity]++;
  return `${c.high} high, ${c.medium} medium, ${c.low} low`;
}

export function formatText(s: RunSummary, color: boolean): string {
  const paint = (code: string, t: string) => (color ? `\x1b[${code}m${t}\x1b[0m` : t);
  const sev = { high: (t: string) => paint("31;1", t), medium: (t: string) => paint("33;1", t), low: (t: string) => paint("36", t) };
  const lines: string[] = [];
  lines.push(paint("1", `safegate ${s.version}`) + `  checked ${s.entriesChecked} endpoints and ${s.migrationsChecked} migrations${s.schemaFound ? "" : " (no schema.prisma found: IDOR rules need it)"}`);
  lines.push("");
  for (const f of sortFindings(s.findings)) {
    lines.push(`${sev[f.severity](f.severity.toUpperCase().padEnd(6))} ${paint("1", f.ruleId)}  ${f.file}:${f.line}`);
    lines.push(`       ${f.message}`);
    lines.push(`       ${paint("32", "fix:")} ${f.fix}`);
    lines.push("");
  }
  lines.push(s.findings.length ? `${s.findings.length} findings (${counts(s.findings)})` : paint("32", "No findings."));
  return lines.join("\n");
}

export function formatJson(s: RunSummary): string {
  return JSON.stringify({ version: s.version, summary: { total: s.findings.length, entriesChecked: s.entriesChecked, migrationsChecked: s.migrationsChecked }, findings: sortFindings(s.findings) }, null, 2);
}

export function formatSarif(s: RunSummary): string {
  const level = { high: "error", medium: "warning", low: "note" } as const;
  return JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "safegate",
              version: s.version,
              informationUri: "https://github.com/your-org/safegate",
              rules: ALL_RULES.map((r) => ({
                id: r.id,
                name: r.name,
                shortDescription: { text: r.description },
                defaultConfiguration: { level: level[r.severity] },
                properties: { "security-severity": r.severity === "high" ? "8.0" : r.severity === "medium" ? "5.0" : "2.0", tags: ["security"] }
              }))
            }
          },
          results: sortFindings(s.findings).map((f) => ({
            ruleId: f.ruleId,
            level: level[f.severity],
            message: { text: `${f.message}\nFix: ${f.fix}` },
            locations: [{ physicalLocation: { artifactLocation: { uri: f.file }, region: { startLine: f.line } } }]
          }))
        }
      ]
    },
    null,
    2
  );
}

/** GitHub Actions workflow commands: shows findings as inline annotations on the PR diff. */
export function formatGithub(s: RunSummary): string {
  const esc = (t: string) => t.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const kind = { high: "error", medium: "warning", low: "notice" };
  const out = sortFindings(s.findings).map((f) => `::${kind[f.severity]} file=${f.file},line=${f.line},title=${f.ruleId}::${esc(`${f.message}\nFix: ${f.fix}`)}`);
  out.push(`safegate: ${s.findings.length} findings (${counts(s.findings)})`);
  return out.join("\n");
}

export function formatMarkdown(s: RunSummary): string {
  if (!s.findings.length) return `### safegate\n\nNo findings in ${s.entriesChecked} endpoints and ${s.migrationsChecked} migrations.`;
  const icon = { high: "🔴", medium: "🟠", low: "🔵" };
  const rows = sortFindings(s.findings).map((f) => `| ${icon[f.severity]} ${f.severity} | \`${f.ruleId}\` | \`${f.file}:${f.line}\` | ${f.message.replace(/\|/g, "\\|")} <br>**Fix:** ${f.fix.replace(/\|/g, "\\|")} |`);
  return [`### safegate: ${s.findings.length} findings (${counts(s.findings)})`, "", "| Severity | Rule | Location | Problem and fix |", "|---|---|---|---|", ...rows].join("\n");
}

export function format(s: RunSummary, fmt: Format, color = false): string {
  switch (fmt) {
    case "json":
      return formatJson(s);
    case "sarif":
      return formatSarif(s);
    case "github":
      return formatGithub(s);
    case "markdown":
      return formatMarkdown(s);
    default:
      return formatText(s, color);
  }
}
