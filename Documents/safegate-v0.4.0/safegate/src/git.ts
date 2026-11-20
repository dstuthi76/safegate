import { execFileSync } from "child_process";

/** Files changed between `base` and HEAD (plus uncommitted changes), relative to the git root, then re-based onto `root`. */
export function changedFiles(root: string, base: string): Set<string> {
  const run = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const prefix = run(["rev-parse", "--show-prefix"]); // root relative to git top, e.g. "apps/web/"
  const names = new Set<string>();
  const add = (out: string) => out.split("\n").filter(Boolean).forEach((n) => names.add(n));
  add(run(["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`]));
  add(run(["diff", "--name-only", "--diff-filter=ACMR", "HEAD"]));
  add(run(["ls-files", "--others", "--exclude-standard"]));
  const out = new Set<string>();
  for (const n of names) {
    if (prefix && !n.startsWith(prefix)) continue;
    out.add(prefix ? n.slice(prefix.length) : n);
  }
  return out;
}
