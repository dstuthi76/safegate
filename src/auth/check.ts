import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { SafegateConfig } from "../config";
import { PrismaSchema } from "../prisma/schema";
import { Finding } from "../types";
import { toPosix } from "../util/files";
import { AuthAnalyzer } from "./analyze";
import { findEntries, matchesName } from "./entries";

export const SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"];

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(m|c)?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function parseSource(abs: string, text?: string): ts.SourceFile {
  return ts.createSourceFile(abs, text ?? fs.readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true, scriptKind(abs));
}

/** Converts a Next.js matcher (path-to-regexp style or regex string) into a RegExp. */
export function matcherToRegExp(m: string): RegExp {
  let s = m
    .replace(/\/:(\w+)\*/g, "(?:/.*)?")
    .replace(/\/:(\w+)\+/g, "/.+")
    .replace(/:(\w+)\?/g, "[^/]*")
    .replace(/:(\w+)/g, "[^/]+");
  try {
    return new RegExp("^" + s + "$");
  } catch {
    s = m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("^" + s);
  }
}

export interface NextMiddleware {
  file: string;
  authed: boolean;
  matchers: RegExp[] | null; // null = all routes
}

/** Reads middleware.ts / proxy.ts (Next.js 16) to learn which paths are protected by authentication. */
export function readNextMiddleware(root: string, config: SafegateConfig): NextMiddleware | null {
  const names = ["middleware", "proxy"];
  const exts = [".ts", ".js", ".mjs", ".tsx"];
  for (const dir of ["", "src"]) {
    for (const n of names) {
      for (const e of exts) {
        const abs = path.join(root, dir, n + e);
        if (!fs.existsSync(abs)) continue;
        const sf = parseSource(abs);
        let authed = false;
        let matchers: RegExp[] | null = null;
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node)) {
            const callee = node.expression.getText(sf);
            if (matchesName(callee, config.authFunctions) || matchesName(callee, config.authWrappers) || /\.protect$/.test(callee)) authed = true;
          }
          if (ts.isPropertyAssignment(node) && node.name.getText(sf) === "matcher") {
            const init = node.initializer;
            const strs: string[] = [];
            if (ts.isStringLiteralLike(init)) strs.push(init.text);
            if (ts.isArrayLiteralExpression(init)) for (const el of init.elements) if (ts.isStringLiteralLike(el)) strs.push(el.text);
            if (strs.length) matchers = strs.map(matcherToRegExp);
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
        // `export { auth as middleware }` / `export default auth`
        if (/export\s*\{\s*auth\s+as\s+(middleware|proxy)\s*\}|export\s+default\s+auth\b/.test(sf.text)) authed = true;
        return { file: toPosix(path.relative(root, abs)), authed, matchers };
      }
    }
  }
  return null;
}

function protectedByMiddleware(mw: NextMiddleware | null, routePath: string | null): boolean {
  if (!mw || !mw.authed || !routePath) return false;
  if (!mw.matchers) return true;
  const concrete = routePath.replace(/\[\[?\.\.\.(\w+)\]?\]/g, "$1/x").replace(/\[(\w+)\]/g, "$1");
  return mw.matchers.some((re) => re.test(concrete));
}

export interface AuthCheckResult {
  findings: Finding[];
  entriesChecked: number;
}

export function checkAuth(root: string, files: string[], config: SafegateConfig, schema: PrismaSchema | null): AuthCheckResult {
  const findings: Finding[] = [];
  const mw = readNextMiddleware(root, config);
  let entriesChecked = 0;
  for (const abs of files) {
    const rel = toPosix(path.relative(root, abs));
    if (/(^|\/)(middleware|proxy)\.(ts|js|mjs|tsx)$/.test(rel)) continue;
    let sf: ts.SourceFile;
    try {
      sf = parseSource(abs);
    } catch {
      continue;
    }
    const entries = findEntries(sf, rel, config);
    if (!entries.length) continue;
    const analyzer = new AuthAnalyzer(sf, rel, config, schema);
    for (const entry of entries) {
      entriesChecked++;
      // Server actions must verify auth themselves (Next.js treats them as public endpoints).
      const mwAuthed = entry.kind !== "server-action" && entry.kind !== "express" && protectedByMiddleware(mw, entry.routePath);
      findings.push(...analyzer.analyze(entry, mwAuthed));
    }
  }
  return { findings, entriesChecked };
}
