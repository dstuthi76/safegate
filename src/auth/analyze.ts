import * as ts from "typescript";
import { SafegateConfig } from "../config";
import { PrismaModel, PrismaSchema } from "../prisma/schema";
import { Finding, RuleMeta } from "../types";
import { Entry, FnNode, indexFunctions, lineOfNode, matchesName } from "./entries";
import { globToRegExp } from "../util/files";

export const AUTH_RULES: RuleMeta[] = [
  { id: "AUTH001", name: "missing-auth", severity: "high", description: "A route handler or server action reads or writes user data without checking who the caller is." },
  { id: "AUTH002", name: "idor-read", severity: "high", description: "A record is loaded by an id from the request without checking that it belongs to the caller (IDOR / broken object-level authorization)." },
  { id: "AUTH003", name: "idor-write", severity: "high", description: "A record is updated or deleted by id without checking that it belongs to the caller (IDOR)." },
  { id: "AUTH004", name: "mass-assignment", severity: "medium", description: "Request input is passed straight into Prisma data, so callers can set fields they should not control." },
  { id: "AUTH005", name: "admin-without-role-check", severity: "high", description: "An admin handler checks that the user is logged in but never checks their role or permissions." }
];
const META = new Map(AUTH_RULES.map((r) => [r.id, r]));

const READ_METHODS = new Set(["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy"]);
const SINGLE_READS = new Set(["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow"]);
const WRITE_METHODS = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert", "delete", "deleteMany"]);
const SCOPED_WRITES = new Set(["update", "updateMany", "upsert", "delete", "deleteMany"]);
const DATA_WRITES = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert"]);

const VALIDATION_RE = /\.(parse|safeParse|parseAsync|validate|validateSync|cast)\s*\(|\bparsed\w*\b|\bvalidated\w*\b|\bsanitiz\w*|\bpick\s*\(/i;
const REQUEST_RE = /\breq(uest)?\b|\.json\s*\(|formData|searchParams|\bparams\b|\bbody\b|\binput\b|\bpayload\b|\bargs\b/i;

interface PrismaCall {
  node: ts.CallExpression;
  model: PrismaModel | null;
  accessor: string;
  method: string;
  pos: number;
}

function make(ruleId: string, file: string, line: number, message: string, fix: string, severity?: Finding["severity"]): Finding {
  const meta = META.get(ruleId)!;
  return { ruleId, severity: severity ?? meta.severity, title: meta.description, message, fix, file, line };
}

function walk(node: ts.Node, cb: (n: ts.Node) => void) {
  cb(node);
  ts.forEachChild(node, (c) => walk(c, cb));
}

function propName(p: ts.ObjectLiteralElementLike, sf: ts.SourceFile): string | null {
  if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)) {
    const n = p.name;
    if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
    return n.getText(sf);
  }
  return null;
}

function getProp(obj: ts.ObjectLiteralExpression, name: string, sf: ts.SourceFile): ts.Expression | null | undefined {
  for (const p of obj.properties) {
    if (propName(p, sf) !== name) continue;
    if (ts.isPropertyAssignment(p)) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p)) return p.name;
  }
  return undefined;
}

/** All property names used anywhere inside an object literal (recursively, through AND/OR arrays and relations). */
function keysDeep(node: ts.Node, sf: ts.SourceFile, out = new Set<string>()): Set<string> {
  walk(node, (n) => {
    if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        const name = propName(p, sf);
        if (name) out.add(name);
      }
    }
  });
  return out;
}

function hasSpread(node: ts.Node): boolean {
  let found = false;
  walk(node, (n) => {
    if (ts.isSpreadAssignment(n)) found = true;
  });
  return found;
}

export class AuthAnalyzer {
  private fileFns: Map<string, ts.Node>;

  constructor(private sf: ts.SourceFile, private rel: string, private config: SafegateConfig, private schema: PrismaSchema | null) {
    this.fileFns = indexFunctions(sf);
  }

  private text(n: ts.Node): string {
    return n.getText(this.sf);
  }

  /** Is there a call to an auth function in this function, or one level into same-file helpers? */
  private authCall(fn: ts.Node, depth = 0, seen = new Set<ts.Node>()): string | null {
    if (seen.has(fn)) return null;
    seen.add(fn);
    let found: string | null = null;
    walk(fn, (n) => {
      if (found || !ts.isCallExpression(n)) return;
      const callee = this.text(n.expression);
      if (matchesName(callee, this.config.authFunctions)) {
        found = callee;
        return;
      }
      if (depth < 2 && ts.isIdentifier(n.expression)) {
        const helper = this.fileFns.get(n.expression.text);
        if (helper) {
          const inner = this.authCall(helper, depth + 1, seen);
          if (inner) found = `${callee} -> ${inner}`;
        }
      }
    });
    return found;
  }

  private prismaCalls(fn: ts.Node): PrismaCall[] {
    const calls: PrismaCall[] = [];
    walk(fn, (n) => {
      if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
      const method = n.expression.name.text;
      if (!READ_METHODS.has(method) && !WRITE_METHODS.has(method)) return;
      const modelAccess = n.expression.expression;
      if (!ts.isPropertyAccessExpression(modelAccess)) return;
      const accessor = modelAccess.name.text;
      const client = modelAccess.expression;
      const clientName = ts.isPropertyAccessExpression(client) ? client.name.text : this.text(client);
      if (!this.config.prismaClientNames.includes(clientName)) return;
      const model = this.schema?.byAccessor.get(accessor) ?? null;
      if (this.schema && !model) return; // not a model (e.g. db.$queryRaw) or unknown
      calls.push({ node: n, model, accessor, method, pos: n.getStart(this.sf) });
    });
    return calls;
  }

  /** Comparisons like post.authorId !== session.user.id, at or before `before` (or anywhere when undefined). */
  private ownershipCheck(fn: ts.Node, before?: number): boolean {
    let found = false;
    walk(fn, (n) => {
      if (found) return;
      if (before !== undefined && n.getStart(this.sf) > before) return;
      if (ts.isBinaryExpression(n)) {
        const op = n.operatorToken.kind;
        if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) {
          const sides = [this.text(n.left), this.text(n.right)];
          if (sides.some((s) => this.config.ownerFields.some((f) => s.endsWith("." + f) || s.endsWith("?." + f)))) found = true;
        }
      }
    });
    return found;
  }

  /** A read on the same model scoped by an owner key that happens before `pos` (ownership lookup before a write). */
  private ownedLookupBefore(calls: PrismaCall[], model: PrismaModel, pos: number): boolean {
    return calls.some((c) => c.pos < pos && c.model === model && READ_METHODS.has(c.method) && this.whereScope(c) === "owned");
  }

  private ownerKeys(model: PrismaModel | null): Set<string> {
    return new Set([...this.config.ownerFields, ...(model?.ownerRelations ?? [])]);
  }

  /** "owned" | "unscoped" | "public" | "none" (no where) | "unknown" (where is not a literal) */
  private whereScope(call: PrismaCall): "owned" | "unscoped" | "public" | "none" | "unknown" {
    const arg = call.node.arguments[0];
    if (!arg) return "none";
    if (!ts.isObjectLiteralExpression(arg)) return "unknown";
    const where = getProp(arg, "where", this.sf);
    if (where === undefined) return hasSpread(arg) ? "unknown" : "none";
    if (!where || !ts.isObjectLiteralExpression(where)) return "unknown";
    const keys = keysDeep(where, this.sf);
    const owner = this.ownerKeys(call.model);
    if ([...keys].some((k) => owner.has(k))) return "owned";
    if ([...keys].some((k) => this.config.publicReadMarkers.includes(k))) return "public";
    if (hasSpread(where)) return "unknown";
    return "unscoped";
  }

  private isOwnedModel(model: PrismaModel | null): boolean {
    return !!model && model.ownerFields.length > 0;
  }

  /** Resolves an expression to whether it carries raw request input. */
  private taint(expr: ts.Expression, fn: FnNode): "tainted" | "validated" | "clean" {
    const txt = this.text(expr);
    if (VALIDATION_RE.test(txt)) return "validated";
    // root identifier: body.data -> body
    let root: ts.Expression = expr;
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root) || ts.isAwaitExpression(root) || ts.isParenthesizedExpression(root) || ts.isAsExpression(root)) {
      root = (root as ts.PropertyAccessExpression).expression;
    }
    if (ts.isIdentifier(root)) {
      const name = root.text;
      const params = fn.parameters.flatMap((p) => (ts.isIdentifier(p.name) ? [p.name.text] : this.bindingNames(p.name)));
      if (params.includes(name)) return "tainted";
      let init: ts.Expression | undefined;
      walk(fn, (n) => {
        if (ts.isVariableDeclaration(n) && n.initializer) {
          if (ts.isIdentifier(n.name) && n.name.text === name) init = n.initializer;
          else if (!ts.isIdentifier(n.name) && this.bindingNames(n.name).includes(name)) init = n.initializer;
        }
      });
      if (init) {
        const it = this.text(init);
        if (VALIDATION_RE.test(it)) return "validated";
        if (REQUEST_RE.test(it) || params.some((p) => new RegExp(`\\b${p}\\b`).test(it))) return "tainted";
        return "clean";
      }
    }
    if (REQUEST_RE.test(txt)) return "tainted";
    return "clean";
  }

  private bindingNames(name: ts.BindingName): string[] {
    if (ts.isIdentifier(name)) return [name.text];
    const out: string[] = [];
    for (const el of name.elements) {
      if (ts.isOmittedExpression(el)) continue;
      out.push(...this.bindingNames(el.name));
    }
    return out;
  }

  private isPublicRoute(entry: Entry): boolean {
    const candidates = [this.rel, entry.routePath ? entry.routePath.replace(/^\//, "") + "/" : ""].filter(Boolean);
    return candidates.some((c) => this.config.publicRoutes.some((g) => globMatch(g, c) || globMatch(g, c + "x")));
  }

  private roleChecked(fn: ts.Node): boolean {
    let found = false;
    const pats = this.config.roleCheckPatterns.map((p) => p.toLowerCase());
    walk(fn, (n) => {
      if (found || !ts.isIdentifier(n)) return;
      const t = n.text.toLowerCase();
      if (pats.some((p) => (p.length >= 4 ? t.includes(p) : t === p))) found = true;
    });
    return found;
  }

  analyze(entry: Entry, middlewareAuthed: boolean): Finding[] {
    const findings: Finding[] = [];
    const fn = entry.fn;
    const where = entry.kind === "server-action" ? `Server action ${entry.name}` : entry.kind === "express" ? `Route ${entry.name}` : `${entry.name} ${entry.routePath ?? ""}`.trim();
    const auth = entry.authedBy ?? this.authCall(fn) ?? (middlewareAuthed ? "middleware" : null);
    const calls = this.prismaCalls(fn);
    const isPublic = this.isPublicRoute(entry);

    // AUTH001 missing auth
    let missingAuth = false;
    if (!auth && !isPublic && calls.length) {
      const writes = calls.filter((c) => WRITE_METHODS.has(c.method));
      const ownedReads = calls.filter((c) => READ_METHODS.has(c.method) && this.isOwnedModel(c.model) && this.whereScope(c) !== "public");
      const target = writes[0] ?? ownedReads[0];
      if (target) {
        missingAuth = true;
        const isWrite = WRITE_METHODS.has(target.method);
        findings.push(
          make(
            "AUTH001",
            this.rel,
            entry.line,
            `${where} calls ${target.accessor}.${target.method}() but never checks who the caller is.${entry.kind === "server-action" ? " Server actions are public HTTP endpoints: anyone can call them directly." : ""}`,
            `Get the session at the top (e.g. const session = await auth(); if (!session) throw new Error("Unauthorized")) and scope the query to session.user.id. If this endpoint is meant to be public, add it to publicRoutes in safegate.config.json.`,
            isWrite ? "high" : "medium"
          )
        );
      }
    }

    // AUTH002 / AUTH003 IDOR (skipped when the whole endpoint is unauthenticated: AUTH001 covers it)
    if (!missingAuth) {
      for (const call of calls) {
        if (!this.isOwnedModel(call.model)) continue;
        const model = call.model!;
        const scope = this.whereScope(call);
        const ownerHint = model.ownerFields[0];
        if (READ_METHODS.has(call.method) && (scope === "unscoped" || (scope === "none" && (call.method === "findMany" || SINGLE_READS.has(call.method))))) {
          if (this.ownershipCheck(fn)) continue;
          if (isPublic) continue;
          findings.push(
            make(
              "AUTH002",
              this.rel,
              lineOfNode(this.sf, call.node),
              scope === "none"
                ? `${where} runs ${call.accessor}.${call.method}() with no where clause on ${model.name}, which is owned by ${ownerHint}: it returns every user's rows.`
                : `${where} loads ${model.name} via ${call.accessor}.${call.method}() without filtering by ${ownerHint} and never compares ${ownerHint} to the current user. Any logged-in user can read another user's ${model.name} by changing the id.`,
              `Add ${ownerHint}: session.user.id to the where clause (Prisma 5+ allows non-unique filters in findUnique/update/delete), or check ${model.accessor}.${ownerHint} === session.user.id before returning it.`
            )
          );
        }
        if (SCOPED_WRITES.has(call.method) && (scope === "unscoped" || scope === "none" || scope === "public")) {
          if (this.ownershipCheck(fn, call.pos) || this.ownedLookupBefore(calls, model, call.pos)) continue;
          findings.push(
            make(
              "AUTH003",
              this.rel,
              lineOfNode(this.sf, call.node),
              `${where} runs ${call.accessor}.${call.method}() on ${model.name} without scoping it to ${ownerHint}. Any logged-in user can ${call.method.startsWith("delete") ? "delete" : "modify"} another user's ${model.name} by changing the id.`,
              `Add ${ownerHint}: session.user.id to the where clause, e.g. where: { id, ${ownerHint}: session.user.id }, or load the record scoped to the user first and return 404 if it is not found.`
            )
          );
        }
      }
    }

    // AUTH004 mass assignment
    for (const call of calls) {
      if (!DATA_WRITES.has(call.method)) continue;
      const arg = call.node.arguments[0];
      if (!arg || !ts.isObjectLiteralExpression(arg)) continue;
      const dataExprs: ts.Expression[] = [];
      for (const key of call.method === "upsert" ? ["create", "update"] : ["data"]) {
        const v = getProp(arg, key, this.sf);
        if (v) dataExprs.push(v);
      }
      for (const data of dataExprs) {
        let risky: ts.Expression | null = null;
        if (ts.isObjectLiteralExpression(data)) {
          for (const p of data.properties) {
            if (ts.isSpreadAssignment(p) && this.taint(p.expression, fn) === "tainted") risky = p.expression;
          }
        } else if (!ts.isArrayLiteralExpression(data) && this.taint(data, fn) === "tainted") {
          risky = data;
        }
        if (!risky) continue;
        const sensitive = call.model ? call.model.fields.filter((f) => this.config.sensitiveFields.includes(f.name)).map((f) => f.name) : [];
        findings.push(
          make(
            "AUTH004",
            this.rel,
            lineOfNode(this.sf, data),
            `${where} passes request input (${this.text(risky).slice(0, 60)}) straight into ${call.accessor}.${call.method}() data.${sensitive.length ? ` ${call.model!.name} has sensitive fields (${sensitive.join(", ")}) that a caller could set.` : ""}`,
            "Validate with a schema that lists only the allowed fields (e.g. zod: const input = UpdateSchema.parse(body)) or copy fields explicitly: data: { title: body.title, content: body.content }.",
            sensitive.length ? "high" : "medium"
          )
        );
      }
    }

    // AUTH005 admin without role check
    const pathish = `${this.rel} ${entry.routePath ?? ""} ${entry.name}`;
    if (/(^|\/)admin(\/|\b)/i.test(pathish) && auth && !this.roleChecked(fn) && !/admin|role/i.test(auth)) {
      findings.push(
        make(
          "AUTH005",
          this.rel,
          entry.line,
          `${where} is an admin endpoint. It checks that the caller is logged in (${auth}) but never checks their role, so any logged-in user can use it.`,
          `Check the role after authentication, e.g. if (session.user.role !== "ADMIN") return new Response("Forbidden", { status: 403 }).`
        )
      );
    }

    return findings;
  }
}

function globMatch(glob: string, value: string): boolean {
  return globToRegExp(glob).test(value);
}
