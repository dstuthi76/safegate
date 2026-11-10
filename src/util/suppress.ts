import * as fs from "fs";
import * as path from "path";
import { Finding } from "../types";

/**
 * A finding is suppressed when its line, or the line above it, carries
 *   // safegate-ignore AUTH002 reason     (TS/JS)
 *   -- safegate-ignore MIG001 reason      (SQL)
 * A bare "safegate-ignore" with no rule id suppresses every rule on that line.
 */
const MARKER = /safegate-ignore(?:\s+([A-Z]+\d+(?:\s*,\s*[A-Z]+\d+)*))?/;

export function isSuppressed(lines: string[], line: number, ruleId: string): boolean {
  for (const candidate of [line, line - 1]) {
    const text = lines[candidate - 1];
    if (!text) continue;
    const m = MARKER.exec(text);
    if (!m) continue;
    if (!m[1]) return true;
    const ids = m[1].split(",").map((s) => s.trim());
    if (ids.includes(ruleId)) return true;
  }
  return false;
}

export function applySuppressions(root: string, findings: Finding[]): Finding[] {
  const cache = new Map<string, string[]>();
  return findings.filter((f) => {
    let lines = cache.get(f.file);
    if (!lines) {
      try {
        lines = fs.readFileSync(path.join(root, f.file), "utf8").split("\n");
      } catch {
        lines = [];
      }
      cache.set(f.file, lines);
    }
    return !isSuppressed(lines, f.line, f.ruleId);
  });
}
