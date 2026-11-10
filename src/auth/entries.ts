import * as ts from "typescript";
import { SafegateConfig } from "../config";

export type EntryKind = "route-handler" | "server-action" | "pages-api" | "express";

export type FnNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

export interface Entry {
  kind: EntryKind;
  /** Exported name, HTTP method, or "METHOD /path" for Express */
  name: string;
  /** URL path when known (Next.js file routes, Express route strings) */
  routePath: string | null;
  fn: FnNode;
  /** Wrapper / middleware that already authenticates the caller, if any */
  authedBy: string | null;
  line: number;
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const EXPRESS_METHODS = ["get", "post", "put", "patch", "delete", "all"];

export function lineOfNode(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function isFn(node: ts.Node | undefined): node is FnNode {
  return !!node && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node));
}

/** Top-level functions and function-valued consts in a file, by name. */
export function indexFunctions(sf: ts.SourceFile): Map<string, ts.Node> {
  const map = new Map<string, ts.Node>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) map.set(stmt.name.text, stmt);
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) map.set(d.name.text, d.initializer);
      }
    }
  }
  return map;
}

/** Follows identifiers and wrapper calls (withAuth(handler)) down to the function that does the work. */
export function resolveFunction(expr: ts.Node, sf: ts.SourceFile, fns: Map<string, ts.Node>, wrappers: string[] = [], seen = new Set<ts.Node>()): { fn: FnNode | null; wrappers: string[] } {
  if (seen.has(expr)) return { fn: null, wrappers };
  seen.add(expr);
  if (isFn(expr)) return { fn: expr, wrappers };
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) return resolveFunction(expr.expression, sf, fns, wrappers, seen);
  if (ts.isIdentifier(expr)) {
    const target = fns.get(expr.text);
    return target ? resolveFunction(target, sf, fns, wrappers, seen) : { fn: null, wrappers };
  }
  if (ts.isCallExpression(expr)) {
    const w = [...wrappers, expr.expression.getText(sf)];
    for (let i = expr.arguments.length - 1; i >= 0; i--) {
      const r = resolveFunction(expr.arguments[i], sf, fns, w, seen);
      if (r.fn) return r;
    }
    // builder style: client.schema(x).action(async () => ...) is handled above via arguments
    return { fn: null, wrappers: w };
  }
  return { fn: null, wrappers };
}

export function matchesName(text: string, names: string[]): boolean {
  return names.some((n) => text === n || text.endsWith("." + n) || text.startsWith(n + "("));
}

function wrapperIsAuth(wrappers: string[], config: SafegateConfig): string | null {
  for (const w of wrappers) {
    if (matchesName(w, config.authWrappers) || matchesName(w, config.authFunctions)) return w;
    // builder clients such as authActionClient.schema(s).action(...)
    if (/\b(auth\w*|\w*Auth\w*|protected\w*|\w*Protected\w*)\b/.test(w) && /action|procedure|handler/i.test(w)) return w;
  }
  return null;
}

function hasDirective(stmts: ts.NodeArray<ts.Statement> | readonly ts.Statement[], directive: string): boolean {
  for (const s of stmts) {
    if (ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression)) {
      if (s.expression.text === directive) return true;
      continue;
    }
    break;
  }
  return false;
}

function isExported(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods && mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** "src/app/api/posts/[id]/route.ts" -> "/api/posts/[id]" */
export function nextRoutePath(rel: string): { kind: "app" | "pages"; path: string } | null {
  const app = /(?:^|\/)app\/(.*)\/route\.(?:ts|js|tsx|jsx|mts|mjs)$/.exec(rel) || /(?:^|\/)app\/()route\.(?:ts|js)$/.exec(rel);
  if (app) {
    const segs = app[1].split("/").filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
    return { kind: "app", path: "/" + segs.join("/") };
  }
  const pages = /(?:^|\/)pages\/(api\/.*)\.(?:ts|js|tsx|jsx)$/.exec(rel);
  if (pages) {
    return { kind: "pages", path: "/" + pages[1].replace(/\/index$/, "") };
  }
  return null;
}

export function findEntries(sf: ts.SourceFile, rel: string, config: SafegateConfig): Entry[] {
  const entries: Entry[] = [];
  const fns = indexFunctions(sf);
  const route = nextRoutePath(rel);
  const fileIsServerActions = hasDirective(sf.statements, "use server");

  const addExport = (name: string, init: ts.Node, at: ts.Node, kind: EntryKind, routePath: string | null) => {
    const { fn, wrappers } = resolveFunction(init, sf, fns);
    if (!fn) return;
    entries.push({ kind, name, routePath, fn, authedBy: wrapperIsAuth(wrappers, config), line: lineOfNode(sf, at) });
  };

  for (const stmt of sf.statements) {
    // export async function GET() {} / export async function updatePost() {}
    if (ts.isFunctionDeclaration(stmt) && stmt.name && isExported(stmt)) {
      const name = stmt.name.text;
      if (route?.kind === "app" && HTTP_METHODS.includes(name)) addExport(name, stmt, stmt, "route-handler", route.path);
      else if (fileIsServerActions) addExport(name, stmt, stmt, "server-action", null);
    }
    // export const POST = withAuth(async () => {}) / export const action = async () => {}
    if (ts.isVariableStatement(stmt) && isExported(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const name = d.name.text;
        if (route?.kind === "app" && HTTP_METHODS.includes(name)) addExport(name, d.initializer, d, "route-handler", route.path);
        else if (fileIsServerActions) addExport(name, d.initializer, d, "server-action", null);
      }
    }
    // pages/api default export
    if (route?.kind === "pages") {
      if (ts.isFunctionDeclaration(stmt) && isExported(stmt) && stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
        addExport("default", stmt, stmt, "pages-api", route.path);
      }
      if (ts.isExportAssignment(stmt)) addExport("default", stmt.expression, stmt, "pages-api", route.path);
    }
  }

  // Inline server actions: function bodies starting with "use server"
  const visitInline = (node: ts.Node) => {
    if (isFn(node) && node.body && ts.isBlock(node.body) && hasDirective(node.body.statements, "use server") && !fileIsServerActions) {
      const name = (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name ? node.name.text : "inline action";
      entries.push({ kind: "server-action", name, routePath: null, fn: node, authedBy: null, line: lineOfNode(sf, node) });
    }
    ts.forEachChild(node, visitInline);
  };
  visitInline(sf);

  // Express: app.get("/path", mw1, mw2, handler)
  const routerAuth = new Map<string, number>(); // router variable -> position of router.use(auth)
  const visitExpress = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const target = node.expression.expression.getText(sf);
      const args = node.arguments;
      if (method === "use") {
        const mws = args.filter((a) => !ts.isStringLiteralLike(a));
        if (mws.some((a) => matchesName(a.getText(sf).replace(/\(.*$/s, ""), config.authMiddleware) || matchesName(a.getText(sf), config.authMiddleware))) {
          // only router-wide when no path or path "/"
          if (!ts.isStringLiteralLike(args[0]) || args[0].text === "/") routerAuth.set(target, node.getStart(sf));
        }
      }
      if (EXPRESS_METHODS.includes(method) && args.length >= 2 && ts.isStringLiteralLike(args[0]) && args[0].text.startsWith("/")) {
        const routePath = args[0].text;
        const handlerArg = args[args.length - 1];
        const { fn, wrappers } = resolveFunction(handlerArg, sf, fns);
        if (fn) {
          let authedBy: string | null = wrapperIsAuth(wrappers, config);
          for (const mw of args.slice(1, -1)) {
            const text = mw.getText(sf);
            const head = ts.isCallExpression(mw) ? mw.expression.getText(sf) : text;
            if (matchesName(head, config.authMiddleware) || matchesName(text, config.authMiddleware)) authedBy = head;
          }
          const useAt = routerAuth.get(target);
          if (!authedBy && useAt !== undefined && useAt < node.getStart(sf)) authedBy = `${target}.use(...)`;
          entries.push({ kind: "express", name: `${method.toUpperCase()} ${routePath}`, routePath, fn, authedBy, line: lineOfNode(sf, node) });
        }
      }
    }
    ts.forEachChild(node, visitExpress);
  };
  visitExpress(sf);

  return entries;
}
