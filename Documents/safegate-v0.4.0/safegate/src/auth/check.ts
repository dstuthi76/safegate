import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { SafegateConfig } from "../config";
import { PrismaSchema } from "../prisma/schema";
import { Finding } from "../types";
import { toPosix } from "../util/files";
import { AuthAnalyzer, CONTEXT_AUTH_RE } from "./analyze";
import { Entry, findEntries, matchesName, NO_PROJECT_AUTH, ProjectAuth } from "./entries";

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

const GUARD_AUTH = /auth|jwt|session|logged|clerk|firebase|supabase|passport|bearer|token|cognito|keycloak/i;

/** Project-wide auth layers: NestJS global guards, graphql-shield, SvelteKit hooks and Nuxt server middleware. */
export function readProjectAuth(root: string, files: string[], config: SafegateConfig): ProjectAuth {
  const out: ProjectAuth = { ...NO_PROJECT_AUTH };
  for (const abs of files) {
    const rel = toPosix(path.relative(root, abs));
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (!out.nestGlobalGuard) {
      const appGuard = /provide:\s*APP_GUARD\s*,\s*useClass:\s*(\w+)/.exec(text) ?? /useClass:\s*(\w+)\s*,\s*provide:\s*APP_GUARD/.exec(text);
      const global = /useGlobalGuards\(([^)]*)\)/.exec(text);
      const consumer = /consumer\s*\.apply\(([^)]*)\)[\s\S]{0,300}?\.forRoutes\(\s*(?:["'`]\*["'`]|\{\s*path:\s*["'`]\*)/.exec(text);
      const hit = [appGuard, global, consumer].find((m) => m && GUARD_AUTH.test(m[1]));
      if (hit) out.nestGlobalGuard = `global guard ${hit[1].trim()} (${rel})`;
    }
    if (!out.graphqlShield && /["']graphql-shield["']/.test(text) && /\bshield\(/.test(text)) out.graphqlShield = `graphql-shield (${rel})`;
    if (!out.graphqlShield && /useGenericAuth\(/.test(text) && /protect-all/.test(text)) out.graphqlShield = `useGenericAuth protect-all (${rel})`;
    if (!out.fileRouteGuard && /(^|\/)(src\/hooks\.server|server\/middleware\/[^/]+)\.(ts|js|mjs)$/.test(rel)) {
      const evidence = CONTEXT_AUTH_RE.test(text) || config.authFunctions.some((f) => new RegExp(`\\b${f.replace(/\./g, "\\.")}\\s*\\(`).test(text));
      const rejects = /\bredirect\s*\(|\berror\s*\(\s*40[13]|createError\s*\(|status(?:Code)?\s*:\s*40[13]|sendRedirect\s*\(/.test(text);
      if (evidence && rejects) {
        const prefixes = [...text.matchAll(/(?:pathname|path|url)\S*\.startsWith\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
        out.fileRouteGuard = { source: rel, prefixes: prefixes.length ? prefixes : null };
      }
    }
  }
  return out;
}

interface ServiceClass {
  rel: string;
  sf: ts.SourceFile;
  cls: ts.ClassDeclaration;
}

/** Classes marked @Injectable(), by name, for following controller -> service calls. */
function serviceIndex(root: string, files: string[]): Map<string, ServiceClass> {
  const out = new Map<string, ServiceClass>();
  for (const abs of files) {
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (!/@Injectable\(/.test(text)) continue;
    const sf = parseSource(abs, text);
    for (const stmt of sf.statements) {
      if (ts.isClassDeclaration(stmt) && stmt.name && (ts.getDecorators(stmt) ?? []).some((d) => /^@Injectable\(/.test(d.getText(sf)))) {
        out.set(stmt.name.text, { rel: toPosix(path.relative(root, abs)), sf, cls: stmt });
      }
    }
  }
  return out;
}

/** constructor(private readonly postsService: PostsService) -> postsService: PostsService */
function memberTypes(fn: ts.Node, sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  let cls: ts.Node | undefined = fn;
  while (cls && !ts.isClassDeclaration(cls)) cls = cls.parent;
  if (!cls) return out;
  for (const m of (cls as ts.ClassDeclaration).members) {
    if (ts.isConstructorDeclaration(m)) for (const p of m.parameters) if (ts.isIdentifier(p.name) && p.type) out.set(p.name.text, p.type.getText(sf));
    if (ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name) && m.type) out.set(m.name.text, m.type.getText(sf));
  }
  return out;
}

export function checkAuth(root: string, files: string[], config: SafegateConfig, schema: PrismaSchema | null, allFiles: string[] = files): AuthCheckResult {
  const findings: Finding[] = [];
  const mw = readNextMiddleware(root, config);
  const project = readProjectAuth(root, allFiles, config);
  let services: Map<string, ServiceClass> | null = null;
  const serviceAnalyzers = new Map<string, AuthAnalyzer>();
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
    const entries = findEntries(sf, rel, config, project);
    if (!entries.length) continue;
    const analyzer = new AuthAnalyzer(sf, rel, config, schema);
    for (const entry of entries) {
      entriesChecked++;
      // Server actions must verify auth themselves (Next.js treats them as public endpoints).
      const mwAuthed = (entry.kind === "route-handler" || entry.kind === "pages-api") && protectedByMiddleware(mw, entry.routePath);
      const own = analyzer.analyze(entry, mwAuthed);
      findings.push(...own);
      if (entry.kind !== "nest") continue;

      // NestJS: follow this.postsService.method() one level into @Injectable services.
      services ??= serviceIndex(root, allFiles);
      if (!services.size) continue;
      const types = memberTypes(entry.fn, sf);
      const auth = analyzer.authOf(entry, mwAuthed);
      const ownership = analyzer.hasOwnershipCheck(entry.fn);
      const seen = new Set<string>();
      for (const call of analyzer.serviceCalls(entry.fn)) {
        const svc = services.get((types.get(call.member) ?? "").replace(/<.*$/, ""));
        if (!svc || seen.has(`${call.member}.${call.method}`)) continue;
        seen.add(`${call.member}.${call.method}`);
        const method = svc.cls.members.find((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && m.name.getText(svc.sf) === call.method && !!m.body);
        if (!method) continue;
        let sa = serviceAnalyzers.get(svc.rel);
        if (!sa) serviceAnalyzers.set(svc.rel, (sa = new AuthAnalyzer(svc.sf, svc.rel, config, schema)));
        const validated = method.parameters.filter((p) => ts.isIdentifier(p.name) && /(Dto|Input|Args)\b/.test(p.type?.getText(svc.sf) ?? "")).map((p) => (p.name as ts.Identifier).text);
        const pseudo: Entry = { kind: "nest", name: `${svc.cls.name!.text}.${call.method}`, routePath: null, fn: method, authedBy: auth, line: lineOfNode(svc.sf, method), validated, className: svc.cls.name!.text };
        for (const f of sa.analyze(pseudo, false, { ownershipElsewhere: ownership })) {
          if (f.ruleId === "AUTH005") continue;
          if (f.ruleId === "AUTH001") {
            if (own.some((o) => o.ruleId === "AUTH001")) continue;
            findings.push({ ...f, file: rel, line: entry.line, message: `${entry.name}${entry.routePath ? ` (${entry.routePath})` : ""} has no auth guard and calls ${call.member}.${call.method}(): ${f.message}` });
            own.push(f);
            continue;
          }
          findings.push(f);
        }
      }
    }
  }
  // The same service method reached from several controllers is reported once.
  const unique = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.ruleId}|${f.file}|${f.line}`;
    if (!unique.has(key)) unique.set(key, f);
  }
  return { findings: [...unique.values()], entriesChecked };
}

function lineOfNode(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}
