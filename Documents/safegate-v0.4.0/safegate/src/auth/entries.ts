import * as ts from "typescript";
import { SafegateConfig } from "../config";

export type EntryKind = "route-handler" | "server-action" | "pages-api" | "express" | "trpc" | "file-route" | "graphql" | "nest";

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
  /** Parameter names the framework already validated, e.g. tRPC input after .input(schema) */
  validated?: string[];
  /** NestJS: the controller or resolver class */
  className?: string;
}

/** Facts about the whole project that change how entries are authenticated. */
export interface ProjectAuth {
  /** NestJS global guard (APP_GUARD / useGlobalGuards / consumer.apply(auth)) */
  nestGlobalGuard: string | null;
  /** graphql-shield or similar permission layer over all resolvers */
  graphqlShield: string | null;
  /** SvelteKit hooks.server / Nuxt server middleware that rejects anonymous requests: path prefixes, or null for all */
  fileRouteGuard: { source: string; prefixes: string[] | null } | null;
}

export const NO_PROJECT_AUTH: ProjectAuth = { nestGlobalGuard: null, graphqlShield: null, fileRouteGuard: null };

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

export function findEntries(sf: ts.SourceFile, rel: string, config: SafegateConfig, project: ProjectAuth = NO_PROJECT_AUTH): Entry[] {
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

  // A name inside an options object or array that is an auth middleware: { preHandler: [authenticate] }
  const authNameIn = (node: ts.Node): string | null => {
    let hit: string | null = null;
    const visit = (n: ts.Node) => {
      if (hit) return;
      if ((ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) && !(n.parent && ts.isPropertyAssignment(n.parent) && n.parent.name === n)) {
        const t = n.getText(sf);
        if (matchesName(t, config.authMiddleware) || matchesName(t, config.authWrappers)) {
          hit = t;
          return;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return hit;
  };

  // Express, Hono, Fastify, Koa, Elysia: app.get("/path", mw1, mw2, handler[, options])
  const routerAuth = new Map<string, { pos: number; prefix: string | null }[]>(); // router -> app.use(auth) calls
  const visitRoutes = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const target = node.expression.expression.getText(sf);
      const args = node.arguments;
      if (method === "use") {
        const mws = args.filter((a) => !ts.isStringLiteralLike(a));
        if (mws.some((a) => matchesName(a.getText(sf).replace(/\(.*$/s, ""), config.authMiddleware) || matchesName(a.getText(sf), config.authMiddleware))) {
          // app.use(auth), app.use("/api", auth), app.use("/api/*", auth)
          const p = args[0] && ts.isStringLiteralLike(args[0]) ? args[0].text : null;
          const prefix = p === null || ["/", "*", "/*"].includes(p) ? null : p.replace(/\/?\*+$/, "").replace(/\/$/, "");
          if (!routerAuth.has(target)) routerAuth.set(target, []);
          routerAuth.get(target)!.push({ pos: node.getStart(sf), prefix });
        }
      }
      if (EXPRESS_METHODS.includes(method) && args.length >= 2 && ts.isStringLiteralLike(args[0]) && args[0].text.startsWith("/")) {
        const routePath = args[0].text;
        let handlerIdx = args.length - 1;
        let r = resolveFunction(args[handlerIdx], sf, fns);
        // Elysia puts an options object after the handler: app.get("/x", handler, { beforeHandle })
        if (!r.fn && args.length >= 3 && ts.isObjectLiteralExpression(args[handlerIdx])) {
          handlerIdx--;
          r = resolveFunction(args[handlerIdx], sf, fns);
        }
        if (r.fn) {
          let authedBy: string | null = wrapperIsAuth(r.wrappers, config);
          for (const mw of [...args.slice(1, handlerIdx), ...args.slice(handlerIdx + 1)]) {
            if (ts.isObjectLiteralExpression(mw) || ts.isArrayLiteralExpression(mw)) {
              authedBy = authNameIn(mw) ?? authedBy;
              continue;
            }
            const text = mw.getText(sf);
            const head = ts.isCallExpression(mw) ? mw.expression.getText(sf) : text;
            if (matchesName(head, config.authMiddleware) || matchesName(text, config.authMiddleware)) authedBy = head;
          }
          const start = node.getStart(sf);
          const use = (routerAuth.get(target) ?? []).find((u) => u.pos < start && (u.prefix === null || routePath === u.prefix || routePath.startsWith(u.prefix + "/")));
          if (!authedBy && use) authedBy = `${target}.use(${use.prefix ?? ""})`;
          entries.push({ kind: "express", name: `${method.toUpperCase()} ${routePath}`, routePath, fn: r.fn, authedBy, line: lineOfNode(sf, node) });
        }
      }
    }
    ts.forEachChild(node, visitRoutes);
  };
  visitRoutes(sf);

  // tRPC: protectedProcedure.input(schema).mutation(async ({ ctx, input }) => ...)
  const visitTrpc = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["query", "mutation", "subscription"].includes(node.expression.name.text) && node.arguments.length >= 1) {
      const text = node.expression.expression.getText(sf);
      const segs = text.split("(")[0].split(".").map((x) => x.trim());
      const base = text.includes("(") ? segs.slice(0, -1) : segs;
      const last = base[base.length - 1] ?? "";
      if (/procedure$/i.test(last)) {
        const { fn } = resolveFunction(node.arguments[0], sf, fns);
        if (fn) {
          let authedBy: string | null = null;
          if (!/^public/i.test(last) && last.toLowerCase() !== "procedure" && /protected|auth|private|admin|user|member|team|org|owner|logged|secure|session|signed/i.test(last)) authedBy = base.join(".");
          const use = /\.use\(\s*([\w.]+)/g;
          let m: RegExpExecArray | null;
          while (!authedBy && (m = use.exec(text))) {
            if (matchesName(m[1], config.authMiddleware) || matchesName(m[1], config.authFunctions) || /auth|session|protect/i.test(m[1])) authedBy = `.use(${m[1]})`;
          }
          if (!authedBy && /\bctx\.(session|user|auth|userId)\b/.test(fn.getText(sf))) authedBy = "ctx.session";
          const parent = node.parent;
          const name = ts.isPropertyAssignment(parent) ? parent.name.getText(sf) : ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : "procedure";
          entries.push({ kind: "trpc", name, routePath: null, fn, authedBy, line: lineOfNode(sf, node), validated: text.includes(".input(") ? ["input"] : [] });
        }
      }
    }
    ts.forEachChild(node, visitTrpc);
  };
  visitTrpc(sf);

  entries.push(...fileRouteEntries(sf, rel, config, fns, project));
  entries.push(...graphqlEntries(sf, config, fns, project));
  entries.push(...nestEntries(sf, config, project));
  entries.push(...builderServerFns(sf, config, fns));
  return entries;
}

// ---------------------------------------------------------------------------------------------
// File-routed frameworks: Remix / React Router, SvelteKit, Nuxt / Nitro, Astro, SolidStart, Qwik

const ROUTE_EXPORTS = [...HTTP_METHODS, "ALL", "fallback", "onGet", "onPost", "onPut", "onPatch", "onDelete", "onRequest"];

function segPath(segs: string[]): string {
  return "/" + segs.filter((x) => x && !/^\(.*\)$/.test(x)).join("/");
}

/** Which file-routed framework a file belongs to, its URL path, and the exports that run on the server. */
export function fileRoute(rel: string): { framework: string; path: string; exports: string[]; method?: string } | null {
  const noExt = rel.replace(/\.(ts|tsx|js|jsx|mts|mjs)$/, "");
  if (noExt === rel) return null;
  // SvelteKit: src/routes/notes/[id]/+server.ts, +page.server.ts, +layout.server.ts
  const svelte = /(?:^|\/)src\/routes\/(?:(.*)\/)?\+(server|page\.server|layout\.server)$/.exec(noExt);
  if (svelte) return { framework: "SvelteKit", path: segPath((svelte[1] ?? "").split("/")), exports: svelte[2] === "server" ? [...HTTP_METHODS, "fallback"] : ["load", "actions"] };
  // Remix / React Router: app/routes/notes.$id.tsx, app/routes/notes/$id.tsx, app/routes/notes.$id/route.tsx
  const remix = /(?:^|\/)app\/routes\/(.*)$/.exec(noExt);
  if (remix) {
    const segs = remix[1].replace(/\/(route|index)$/, "").replace(/\//g, ".").split(".");
    const out = segs.filter((x) => x && x !== "_index" && !x.startsWith("_") && !x.startsWith("(")).map((x) => (x === "$" ? "*" : x.startsWith("$") ? ":" + x.slice(1) : x.replace(/_$/, "")));
    return { framework: "Remix", path: "/" + out.join("/"), exports: ["loader", "action"] };
  }
  // Nuxt / Nitro: server/api/notes/[id].delete.ts
  const nuxt = /(?:^|\/)server\/(api|routes)\/(.*)$/.exec(noExt);
  if (nuxt) {
    const m = /\.(get|post|put|patch|delete|head|options)$/.exec(nuxt[2]);
    const route = (m ? nuxt[2].slice(0, -m[0].length) : nuxt[2]).replace(/(^|\/)index$/, "");
    return { framework: "Nuxt", path: segPath([nuxt[1] === "api" ? "api" : "", ...route.split("/")]), exports: ["default"], method: m ? m[1].toUpperCase() : "ALL" };
  }
  // Astro (src/pages), SolidStart and Qwik (src/routes)
  const generic = /(?:^|\/)(?:src\/)?(pages|routes)\/(.*)$/.exec(noExt);
  if (generic && !/(?:^|\/)app\//.test(rel)) return { framework: generic[1] === "pages" ? "Astro" : "SolidStart/Qwik", path: segPath(generic[2].replace(/(^|\/)index$/, "").split("/")), exports: ROUTE_EXPORTS };
  return null;
}

function fileRouteEntries(sf: ts.SourceFile, rel: string, config: SafegateConfig, fns: Map<string, ts.Node>, project: ProjectAuth): Entry[] {
  const fr = fileRoute(rel);
  if (!fr || nextRoutePath(rel)?.kind === "app") return [];
  const out: Entry[] = [];
  const guard = project.fileRouteGuard;
  const guarded = guard && (guard.prefixes === null || guard.prefixes.some((p) => fr.path === p || fr.path.startsWith(p.replace(/\/$/, "") + "/"))) ? guard.source : null;
  const add = (name: string, init: ts.Node, at: ts.Node) => {
    // Nuxt: defineEventHandler({ onRequest: [auth], handler })
    if (ts.isCallExpression(init) && init.arguments[0] && ts.isObjectLiteralExpression(init.arguments[0])) {
      const obj = init.arguments[0];
      const h = obj.properties.find((p) => p.name?.getText(sf) === "handler");
      const before = obj.properties.find((p) => /^on(Request|BeforeResponse)$/.test(p.name?.getText(sf) ?? ""));
      if (h && (ts.isPropertyAssignment(h) || ts.isMethodDeclaration(h))) {
        const { fn } = resolveFunction(ts.isPropertyAssignment(h) ? h.initializer : h, sf, fns);
        if (fn) {
          const auth = before && ts.isPropertyAssignment(before) ? authNameInNode(before.initializer, sf, config) : null;
          out.push({ kind: "file-route", name: `${fr.method ?? name}`, routePath: fr.path, fn, authedBy: auth ?? guarded, line: lineOfNode(sf, at) });
        }
        return;
      }
    }
    const { fn, wrappers } = resolveFunction(init, sf, fns);
    if (!fn) return;
    out.push({ kind: "file-route", name: fr.method ?? name, routePath: fr.path, fn, authedBy: wrapperIsAuth(wrappers, config) ?? guarded, line: lineOfNode(sf, at) });
  };
  const addActions = (obj: ts.Expression) => {
    // SvelteKit: export const actions = { default: async (event) => ..., delete: async () => ... }
    if (!ts.isObjectLiteralExpression(obj)) return;
    for (const p of obj.properties) {
      if (ts.isPropertyAssignment(p)) add(`action ${p.name.getText(sf)}`, p.initializer, p);
      else if (ts.isMethodDeclaration(p)) add(`action ${p.name.getText(sf)}`, p, p);
    }
  };
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && isExported(stmt) && fr.exports.includes(stmt.name.text)) add(stmt.name.text, stmt, stmt);
    if (ts.isVariableStatement(stmt) && isExported(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const name = d.name.text;
        if (name === "actions" && fr.exports.includes("actions")) addActions(d.initializer);
        else if (fr.exports.includes(name)) add(name, d.initializer, d);
        // Qwik: export const useAddTodo = routeAction$(async (data) => ...)
        else if (ts.isCallExpression(d.initializer) && /^(routeLoader\$|routeAction\$|globalAction\$|server\$)$/.test(d.initializer.expression.getText(sf))) add(name, d.initializer, d);
      }
    }
    if (ts.isExportAssignment(stmt) && fr.exports.includes("default")) add("default", stmt.expression, stmt);
  }
  return out;
}

/** An auth middleware or guard named anywhere inside a node (options object, array, decorator). */
export function authNameInNode(node: ts.Node, sf: ts.SourceFile, config: SafegateConfig): string | null {
  let hit: string | null = null;
  const visit = (n: ts.Node) => {
    if (hit) return;
    if ((ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) && !(n.parent && ts.isPropertyAssignment(n.parent) && n.parent.name === n)) {
      const t = n.getText(sf);
      if (matchesName(t, config.authMiddleware) || matchesName(t, config.authWrappers) || matchesName(t, config.authFunctions)) {
        hit = t;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

// ---------------------------------------------------------------------------------------------
// GraphQL: resolver maps (Apollo, Yoga, Mercurius), Pothos and Nexus field resolvers

const GQL_ROOTS = new Set(["Query", "Mutation", "Subscription"]);

function graphqlEntries(sf: ts.SourceFile, config: SafegateConfig, fns: Map<string, ts.Node>, project: ProjectAuth): Entry[] {
  const out: Entry[] = [];
  const add = (root: string, name: string, init: ts.Node, at: ts.Node, extraAuth: string | null) => {
    const { fn, wrappers } = resolveFunction(init, sf, fns);
    if (!fn) return;
    let authedBy = extraAuth ?? wrapperIsAuth(wrappers, config);
    // combineResolvers(isAuthenticated, resolver), compose(requireAuth)(resolver)
    if (!authedBy && ts.isCallExpression(init)) {
      for (const a of [init.expression, ...init.arguments]) {
        if (a === fn) continue;
        if ((ts.isIdentifier(a) || ts.isPropertyAccessExpression(a) || ts.isCallExpression(a)) && authNameInNode(a, sf, config) && !isFn(a)) authedBy = a.getText(sf).slice(0, 60);
      }
    }
    // async updatePost(_parent, args, { user }) reads the user from the context
    const ctxParam = fn.parameters[2];
    if (!authedBy && ctxParam && ts.isObjectBindingPattern(ctxParam.name) && ctxParam.name.elements.some((e) => /^(user|session|currentUser|viewer|auth|userId)$/.test((e.propertyName ?? e.name).getText(sf)))) authedBy = "context.user";
    out.push({ kind: "graphql", name: `${root}.${name}`, routePath: null, fn, authedBy: authedBy ?? project.graphqlShield, line: lineOfNode(sf, at) });
  };
  const visit = (node: ts.Node) => {
    // const resolvers = { Query: { note: (_, { id }, ctx) => ... }, Mutation: { ... } }
    if (ts.isPropertyAssignment(node) && GQL_ROOTS.has(node.name.getText(sf).replace(/["']/g, "")) && ts.isObjectLiteralExpression(node.initializer)) {
      const root = node.name.getText(sf).replace(/["']/g, "");
      for (const p of node.initializer.properties) {
        if (ts.isPropertyAssignment(p)) {
          // Subscription: { onX: { subscribe: fn, resolve: fn } }
          const target = ts.isObjectLiteralExpression(p.initializer) ? p.initializer.properties.find((q) => /^(resolve|subscribe)$/.test(q.name?.getText(sf) ?? "")) : p;
          if (target && ts.isPropertyAssignment(target)) add(root, p.name.getText(sf), target.initializer, p, null);
          else if (target && ts.isMethodDeclaration(target)) add(root, p.name.getText(sf), target, p, null);
        } else if (ts.isMethodDeclaration(p)) add(root, p.name.getText(sf), p, p, null);
      }
    }
    // Pothos: builder.mutationField("deleteNote", (t) => t.field({ authScopes: {...}, resolve: ... }))
    // Nexus:  mutationField("deleteNote", { type, args, authorize, resolve })
    if (ts.isCallExpression(node) && /(^|\.)(queryField|mutationField|subscriptionField|queryFields|mutationFields|queryType|mutationType|extendType|objectType)$/.test(node.expression.getText(sf))) {
      const callee = node.expression.getText(sf);
      const root = /mutation/i.test(callee) ? "Mutation" : /subscription/i.test(callee) ? "Subscription" : "Query";
      if (/(extendType|objectType)$/.test(callee)) {
        const t = node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0]) ? node.arguments[0].properties.find((p) => /^(type|name)$/.test(p.name?.getText(sf) ?? "")) : undefined;
        if (!t || !ts.isPropertyAssignment(t) || !ts.isStringLiteralLike(t.initializer) || !GQL_ROOTS.has(t.initializer.text)) {
          ts.forEachChild(node, visit);
          return;
        }
      }
      const fieldName = node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) ? node.arguments[0].text : null;
      const walkResolve = (n: ts.Node) => {
        if (ts.isObjectLiteralExpression(n)) {
          const resolve = n.properties.find((p) => p.name?.getText(sf) === "resolve");
          if (resolve && (ts.isPropertyAssignment(resolve) || ts.isMethodDeclaration(resolve))) {
            const auth = n.properties.find((p) => /^(authScopes|authorize|shield|grantScopes|authz)$/.test(p.name?.getText(sf) ?? ""));
            // nearest name: t.field("x", {...}) / t.nonNull.field("x", ...) / definition(t) { t.field("x", ...) }
            const callName = n.parent && ts.isCallExpression(n.parent) && n.parent.arguments[0] && ts.isStringLiteralLike(n.parent.arguments[0]) ? n.parent.arguments[0].text : null;
            const keyName = n.parent && ts.isPropertyAssignment(n.parent) ? n.parent.name.getText(sf) : null;
            add(root, fieldName ?? callName ?? keyName ?? "field", ts.isPropertyAssignment(resolve) ? resolve.initializer : resolve, n, auth ? auth.name!.getText(sf) : null);
          }
        }
        ts.forEachChild(n, walkResolve);
      };
      for (const a of node.arguments) walkResolve(a);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// ---------------------------------------------------------------------------------------------
// NestJS controllers and resolvers (also TypeGraphQL resolvers)

const NEST_ROUTES: Record<string, string> = { Get: "GET", Post: "POST", Put: "PUT", Patch: "PATCH", Delete: "DELETE", All: "ALL", Head: "HEAD", Options: "OPTIONS", Query: "Query", Mutation: "Mutation", Subscription: "Subscription" };
const NEST_PUBLIC = /^(Public|IsPublic|AllowAnonymous|SkipAuth|Anonymous|NoAuth|PublicRoute|Unprotected|AllowUnauthenticated)$/;
const GUARD_AUTH = /auth|jwt|session|logged|clerk|firebase|supabase|passport|bearer|token|cognito|keycloak|user/i;

function decs(node: ts.Node): ts.Decorator[] {
  return ts.canHaveDecorators(node) ? [...(ts.getDecorators(node) ?? [])] : [];
}

function decoratorName(d: ts.Decorator): string {
  const e = d.expression;
  const callee = ts.isCallExpression(e) ? e.expression : e;
  return ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
}

/** @UseGuards(JwtAuthGuard), @Auth(), @Authorized(), @Roles("admin") and friends. */
function nestAuth(nodeDecs: ts.Decorator[], sf: ts.SourceFile, config: SafegateConfig): string | null {
  const parts: string[] = [];
  for (const d of nodeDecs) {
    const name = decoratorName(d);
    const text = d.expression.getText(sf);
    if (name === "UseGuards" && (GUARD_AUTH.test(text) || authNameInNode(d.expression, sf, config))) parts.push(text);
    else if (/^(Auth|Authorized|Authenticated|RequireAuth|Protected|ApiAuth|UseAuth|Roles|RequireRoles|Permissions|RequirePermissions|AdminOnly|CheckPolicies|Can)$/.test(name)) parts.push(text);
  }
  return parts.length ? parts.join(" ") : null;
}

function nestEntries(sf: ts.SourceFile, config: SafegateConfig, project: ProjectAuth): Entry[] {
  const out: Entry[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) && node.name) {
      const cdecs = decs(node);
      const marker = cdecs.find((d) => ["Controller", "Resolver"].includes(decoratorName(d)));
      if (marker) {
        const arg = ts.isCallExpression(marker.expression) ? marker.expression.arguments[0] : undefined;
        const prefix = arg && ts.isStringLiteralLike(arg) ? arg.text : arg && ts.isObjectLiteralExpression(arg) ? (arg.properties.find((p) => p.name?.getText(sf) === "path") as ts.PropertyAssignment | undefined)?.initializer.getText(sf).replace(/["'`]/g, "") ?? "" : "";
        const classAuth = nestAuth(cdecs, sf, config);
        const classPublic = cdecs.some((d) => NEST_PUBLIC.test(decoratorName(d)));
        for (const m of node.members) {
          if (!ts.isMethodDeclaration(m) || !m.body) continue;
          const mdecs = decs(m);
          const route = mdecs.find((d) => decoratorName(d) in NEST_ROUTES);
          if (!route) continue;
          const verb = NEST_ROUTES[decoratorName(route)];
          const rarg = ts.isCallExpression(route.expression) ? route.expression.arguments[0] : undefined;
          const sub = rarg && ts.isStringLiteralLike(rarg) ? rarg.text : "";
          const isGql = ["Query", "Mutation", "Subscription"].includes(verb);
          const routePath = isGql ? null : ("/" + [prefix, sub].filter(Boolean).join("/")).replace(/\/+/g, "/");
          const isPublic = classPublic || mdecs.some((d) => NEST_PUBLIC.test(decoratorName(d)));
          const methodAuth = nestAuth(mdecs, sf, config);
          const authedBy = [classAuth, methodAuth].filter(Boolean).join(" ") || (!isPublic ? project.nestGlobalGuard : null) || (isGql ? project.graphqlShield : null);
          // Params validated by Nest: DTO classes, ValidationPipe / ZodValidationPipe
          const validated: string[] = [];
          for (const p of m.parameters) {
            if (!ts.isIdentifier(p.name)) continue;
            const type = p.type?.getText(sf) ?? "";
            const pdecs = decs(p).map((d) => d.expression.getText(sf)).join(" ");
            if (/(Dto|Input|Args|Request\b)\b/.test(type) && !/^(Request|any|unknown|object|Record)/.test(type) || /Pipe\b/.test(pdecs) && /(Validation|Zod|Parse|Joi|Yup)/.test(pdecs)) validated.push(p.name.text);
          }
          out.push({ kind: "nest", name: `${node.name.text}.${m.name.getText(sf)}`, routePath: isGql ? null : routePath, fn: m, authedBy, line: lineOfNode(sf, m), validated, className: node.name.text });
          if (isGql) out[out.length - 1].name = `${verb} ${node.name.text}.${m.name.getText(sf)}`;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// TanStack Start: createServerFn({ method: "POST" }).validator(schema).handler(async ({ data }) => ...)
function builderServerFns(sf: ts.SourceFile, config: SafegateConfig, fns: Map<string, ts.Node>): Entry[] {
  const out: Entry[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "handler" && /\bcreateServerFn\s*\(/.test(node.expression.expression.getText(sf))) {
      const { fn } = resolveFunction(node.arguments[0], sf, fns);
      if (fn) {
        const chain = node.expression.expression.getText(sf);
        const mw = /\.middleware\(\s*\[([^\]]*)\]/.exec(chain);
        const authedBy = mw && /auth|session|protect|user/i.test(mw[1]) ? `.middleware([${mw[1].trim()}])` : null;
        const parent = node.parent;
        const name = ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : "serverFn";
        out.push({ kind: "server-action", name, routePath: null, fn, authedBy, line: lineOfNode(sf, node), validated: /\.(validator|inputValidator)\(/.test(chain) ? ["data"] : [] });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
