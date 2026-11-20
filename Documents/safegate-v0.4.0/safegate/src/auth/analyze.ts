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
  { id: "AUTH004", name: "mass-assignment", severity: "medium", description: "Request input is passed straight into a database write, so callers can set fields they should not control." },
  { id: "AUTH005", name: "admin-without-role-check", severity: "high", description: "An admin handler checks that the user is logged in but never checks their role or permissions." }
];
const META = new Map(AUTH_RULES.map((r) => [r.id, r]));

const READ_METHODS = new Set(["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy"]);
const SINGLE_READS = new Set(["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow"]);
const WRITE_METHODS = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert", "delete", "deleteMany"]);
const SCOPED_WRITES = new Set(["update", "updateMany", "upsert", "delete", "deleteMany"]);
const DATA_WRITES = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert"]);

/** Reading the authenticated user from framework context counts as an auth check. */
export const CONTEXT_AUTH_RE =
  /\b(?:req|request)\.(?:user\b|auth\b|session\.(?:user|userId)\b|isAuthenticated\(\)|jwtVerify\()|\b(?:locals|Astro\.locals)\.(?:user\b|session\b|auth\(|safeGetSession\(|getSession\(|getUser\(|authStore\b)|\bevent\.context\.(?:user|session|auth)\b|\bctx\.state\.(?:user|auth)\b|\b(?:context|ctx|contextValue)\.(?:user|currentUser|session|auth|viewer|userId)\b|\bc\.(?:get\(\s*["'](?:user|session|jwtPayload|auth)["']|var\.(?:user|session)\b)|\b(?:getUserSession|requireUserSession|serverSupabaseUser|getKindeServerSession|requireUserId|getUserId|getServerUser)\s*\(/;

const VALIDATION_RE = /\.(parse|safeParse|parseAsync|validate|validateSync|cast)\s*\(|\bparsed\w*\b|\bvalidated\w*\b|\bsanitiz\w*|\bpick\s*\(/i;
const REQUEST_RE = /\breq(uest)?\b|\.json\s*\(|formData|searchParams|\bparams\b|\bbody\b|\binput\b|\bpayload\b|\bargs\b/i;

/** One database call, from any supported ORM or query builder, normalised to Prisma's method names. */
export interface DbCall {
  node: ts.CallExpression | ts.NewExpression;
  model: PrismaModel | null;
  accessor: string;
  method: string;
  pos: number;
  /** How the call reads in messages, e.g. post.findUnique() or update(posts) */
  label: string;
  /** object: TypeORM, MikroORM, Sequelize, Mongoose. columns: Kysely, Knex */
  orm: "prisma" | "drizzle" | "object" | "columns";
  /** The filter: undefined when none is given, "unknown" when it cannot be read, "byId" for findById(id) and friends */
  where: ts.Expression | undefined | "unknown" | "byId";
  /** Column names used in the filter (Kysely, Knex) */
  columns?: Set<string>;
  /** Expressions written to the table (data, set, values) */
  data: ts.Expression[];
  /** Names that refer to the table inside a Drizzle filter */
  tableRefs: Set<string>;
}

const DRIZZLE_BUILDERS = new Set(["select", "selectDistinct", "selectDistinctOn", "update", "delete", "insert"]);

/**
 * Object-style ORMs (TypeORM, MikroORM, Sequelize, Mongoose), normalised to Prisma method names.
 * shape says where the filter and data are: opts ({ where } or a filter), filter, id, data,
 * criteriaData (filter or id, then data), remove (an entity loaded earlier).
 */
type Shape = "opts" | "filter" | "id" | "data" | "criteriaData" | "remove";
const OBJECT_METHODS: Record<string, [string, Shape]> = {
  find: ["findMany", "opts"],
  findAll: ["findMany", "opts"],
  findAndCount: ["findMany", "opts"],
  findAndCountAll: ["findMany", "opts"],
  findBy: ["findMany", "filter"],
  findOne: ["findFirst", "opts"],
  findOneOrFail: ["findFirst", "opts"],
  findOneBy: ["findFirst", "filter"],
  findOneByOrFail: ["findFirst", "filter"],
  findOneOrCreate: ["findFirst", "filter"],
  findById: ["findUnique", "id"],
  findByPk: ["findUnique", "id"],
  findByIds: ["findMany", "id"],
  count: ["count", "opts"],
  countBy: ["count", "filter"],
  countDocuments: ["count", "filter"],
  exists: ["findFirst", "filter"],
  existsBy: ["findFirst", "filter"],
  create: ["create", "data"],
  save: ["create", "data"],
  insert: ["create", "data"],
  insertMany: ["createMany", "data"],
  bulkCreate: ["createMany", "data"],
  upsert: ["create", "data"],
  update: ["update", "criteriaData"],
  updateOne: ["update", "criteriaData"],
  updateMany: ["updateMany", "criteriaData"],
  findOneAndUpdate: ["update", "criteriaData"],
  findByIdAndUpdate: ["update", "criteriaData"],
  replaceOne: ["update", "criteriaData"],
  nativeUpdate: ["updateMany", "criteriaData"],
  delete: ["delete", "filter"],
  softDelete: ["delete", "filter"],
  deleteOne: ["delete", "filter"],
  deleteMany: ["deleteMany", "filter"],
  findOneAndDelete: ["delete", "filter"],
  findByIdAndDelete: ["delete", "id"],
  findByIdAndRemove: ["delete", "id"],
  nativeDelete: ["deleteMany", "filter"],
  destroy: ["delete", "opts"],
  remove: ["delete", "remove"],
  softRemove: ["delete", "remove"]
};
const OPTION_KEYS = new Set(["relations", "order", "include", "attributes", "select", "take", "skip", "limit", "offset", "populate", "lean", "sort", "projection", "cache", "lock", "withDeleted", "orderBy", "fields", "transaction", "raw", "paranoid", "group"]);
const ENTITY_MANAGER = /^(em|entityManager|manager|orm\.em|.*\.(em|manager|entityManager))$/i;

/** Kysely: db.selectFrom("posts")... Knex: knex("posts")... */
const KYSELY_ROOTS: Record<string, string> = { selectFrom: "findMany", updateTable: "update", deleteFrom: "delete", insertInto: "create", replaceInto: "create" };
const KNEX_CLIENTS = /^(knex|trx|db|database|pg|sql|qb|k)$/i;

function snakeCase(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function singular(s: string): string {
  return s.endsWith("ies") ? s.slice(0, -3) + "y" : s.endsWith("ses") ? s.slice(0, -2) : s.endsWith("s") && !s.endsWith("ss") ? s.slice(0, -1) : s;
}

/** The calls chained onto a call: db.update(t).set(x).where(y) -> update, set, where */
function chainSteps(n: ts.CallExpression, firstName: string): { name: string; args: ts.NodeArray<ts.Expression>; node: ts.CallExpression }[] {
  const steps = [{ name: firstName, args: n.arguments, node: n }];
  let cur: ts.Node = n;
  while (cur.parent && ts.isPropertyAccessExpression(cur.parent) && cur.parent.expression === cur && cur.parent.parent && ts.isCallExpression(cur.parent.parent) && cur.parent.parent.expression === cur.parent) {
    steps.push({ name: cur.parent.name.text, args: cur.parent.parent.arguments, node: cur.parent.parent });
    cur = cur.parent.parent;
  }
  return steps;
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
  /** Parameter names already validated by the framework (tRPC .input(schema)) */
  private validated = new Set<string>();
  private currentFn: FnNode | null = null;

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
    if (depth === 0) {
      const m = CONTEXT_AUTH_RE.exec(this.text(fn));
      if (m) return m[0];
    }
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

  private clientOk(e: ts.Expression): boolean {
    const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : "";
    return this.config.prismaClientNames.includes(name);
  }

  private filterOf(arg: ts.Expression | undefined): DbCall["where"] {
    if (!arg) return undefined;
    if (!ts.isObjectLiteralExpression(arg)) return "unknown";
    const w = getProp(arg, "where", this.sf);
    if (w === undefined) return hasSpread(arg) ? "unknown" : undefined;
    return w ?? "unknown";
  }

  private dbCalls(fn: ts.Node): DbCall[] {
    const calls: DbCall[] = [];
    walk(fn, (n) => {
      if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
      const p = n.expression;
      const op = p.name.text;
      const pos = n.getStart(this.sf);

      // Drizzle relational queries: db.query.posts.findFirst({ where })
      if ((op === "findFirst" || op === "findMany") && ts.isPropertyAccessExpression(p.expression) && ts.isPropertyAccessExpression(p.expression.expression) && p.expression.expression.name.text === "query" && this.clientOk(p.expression.expression.expression)) {
        const accessor = p.expression.name.text;
        calls.push({ node: n, model: this.schema?.byAccessor.get(accessor) ?? null, accessor, method: op, pos, label: `query.${accessor}.${op}()`, orm: "drizzle", where: this.filterOf(n.arguments[0]), data: [], tableRefs: new Set([accessor]) });
        return;
      }

      // Drizzle builders: db.update(posts).set(data).where(cond)
      if (DRIZZLE_BUILDERS.has(op) && this.clientOk(p.expression)) {
        const steps = chainSteps(n, op);
        const step = (name: string) => steps.find((st) => st.name === name);
        const isSelect = op.startsWith("select");
        const tableExpr = isSelect ? step("from")?.args[0] : n.arguments[0];
        const accessor = tableExpr && ts.isIdentifier(tableExpr) ? tableExpr.text : tableExpr && ts.isPropertyAccessExpression(tableExpr) ? tableExpr.name.text : null;
        if (!accessor) return;
        const whereStep = step("where");
        const data: ts.Expression[] = [];
        if (op === "update" && step("set")?.args[0]) data.push(step("set")!.args[0]);
        if (op === "insert") {
          const v = step("values")?.args[0];
          if (v && ts.isArrayLiteralExpression(v)) data.push(...v.elements.filter((e) => !ts.isSpreadElement(e)));
          else if (v) data.push(v);
          const upsert = step("onConflictDoUpdate")?.args[0];
          if (upsert && ts.isObjectLiteralExpression(upsert)) {
            const set = getProp(upsert, "set", this.sf);
            if (set) data.push(set);
          }
        }
        const limit1 = steps.some((st) => st.name === "limit" && st.args[0] && ts.isNumericLiteral(st.args[0]) && st.args[0].text === "1");
        const method = isSelect ? (limit1 ? "findFirst" : "findMany") : op === "insert" ? "create" : op;
        calls.push({
          node: n,
          model: this.schema?.byAccessor.get(accessor) ?? null,
          accessor,
          method,
          pos,
          label: isSelect ? `select().from(${accessor})` : `${op}(${accessor})`,
          orm: "drizzle",
          where: whereStep ? whereStep.args[0] ?? "unknown" : undefined,
          data,
          tableRefs: new Set([accessor])
        });
        return;
      }

      // Prisma: prisma.post.findUnique({ where })
      const prismaCall = (): boolean => {
      if (!READ_METHODS.has(op) && !WRITE_METHODS.has(op)) return false;
      const modelAccess = p.expression;
      if (!ts.isPropertyAccessExpression(modelAccess)) return false;
      const accessor = modelAccess.name.text;
      if (!this.clientOk(modelAccess.expression)) return false;
      const model = this.schema?.byAccessor.get(accessor) ?? null;
      if (model?.source) return false; // e.g. db.Post.update(...) on a Sequelize model
      if (this.schema && !model) return !this.modelByName(accessor); // not a model (e.g. db.$queryRaw) or unknown
      const arg = n.arguments[0];
      const data: ts.Expression[] = [];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const key of op === "upsert" ? ["create", "update"] : ["data"]) {
          const v = getProp(arg, key, this.sf);
          if (v) data.push(v);
        }
      }
      calls.push({ node: n, model, accessor, method: op, pos, label: `${accessor}.${op}()`, orm: "prisma", where: this.filterOf(arg), data, tableRefs: new Set() });
      return true;
      };
      if (prismaCall()) return;
      const obj = this.objectCall(n, p, pos);
      if (obj) {
        calls.push(obj);
        return;
      }
      const cols = this.kyselyCall(n, p, pos);
      if (cols) calls.push(cols);
    });
    // Knex: knex("posts").where({ id }).first()  and  new Post(req.body) (Mongoose, ActiveRecord)
    walk(fn, (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && KNEX_CLIENTS.test(n.expression.text) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
        const c = this.knexCall(n, n.arguments[0].text, n.expression.text);
        if (c) calls.push(c);
      }
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ["from", "table", "into"].includes(n.expression.name.text) && ts.isIdentifier(n.expression.expression) && /^(knex|trx)$/i.test(n.expression.expression.text) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
        const c = this.knexCall(n, n.arguments[0].text, `${n.expression.expression.text}.${n.expression.name.text}`);
        if (c) calls.push(c);
      }
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.arguments?.[0]) {
        const model = this.modelByName(n.expression.text, true);
        if (model && (model.source === "mongoose" || model.source === "typeorm" || model.source === "sequelize")) {
          calls.push({ node: n, model, accessor: model.accessor, method: "create", pos: n.getStart(this.sf), label: `new ${n.expression.text}()`, orm: "object", where: undefined, data: [this.unwrapSet(n.arguments[0])], tableRefs: new Set() });
        }
      }
    });
    calls.sort((a, b) => a.pos - b.pos);
    return calls;
  }

  /** Model for a name such as postRepository, this.postModel, PostEntity, posts or Post. */
  private modelByName(raw: string, exact = false): PrismaModel | null {
    if (!this.schema) return null;
    const name = raw.replace(/^this\./, "").split(".").pop()!;
    const direct = this.schema.models.find((m) => m.source && (m.accessor === name || m.name === name));
    if (direct || exact) return direct ?? null;
    const base = name.replace(/(Repository|Repo|Model|Collection|Entity|Schema|Table)$/i, "");
    // a bare lower-case name (posts.find(...)) is usually a local array, not a model
    if (!base || (base === name && !/^[A-Z]/.test(name))) return null;
    const key = singular(base).toLowerCase();
    return this.schema.models.find((m) => m.source && [m.name, m.accessor, m.dbName].some((x) => singular(x).toLowerCase() === key)) ?? null;
  }

  private memberModelCache = new Map<ts.Node, Map<string, PrismaModel>>();

  /** NestJS DI: constructor(@InjectRepository(Post) private repo: Repository<Post>) and typed properties. */
  private memberModel(node: ts.Node, member: string): PrismaModel | null {
    let cls: ts.Node | undefined = node;
    while (cls && !ts.isClassDeclaration(cls) && !ts.isClassExpression(cls)) cls = cls.parent;
    if (!cls || !this.schema) return null;
    let map = this.memberModelCache.get(cls);
    if (!map) {
      map = new Map();
      const c = cls as ts.ClassDeclaration;
      const typed: { name: string; type: string; decText: string }[] = [];
      for (const m of c.members) {
        if (ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name)) typed.push({ name: m.name.text, type: m.type?.getText(this.sf) ?? "", decText: (ts.canHaveDecorators(m) ? ts.getDecorators(m) ?? [] : []).map((d) => d.getText(this.sf)).join(" ") });
        if (ts.isConstructorDeclaration(m)) {
          for (const p of m.parameters) {
            if (ts.isIdentifier(p.name)) typed.push({ name: p.name.text, type: p.type?.getText(this.sf) ?? "", decText: (ts.canHaveDecorators(p) ? ts.getDecorators(p) ?? [] : []).map((d) => d.getText(this.sf)).join(" ") });
          }
        }
      }
      for (const t of typed) {
        const inj = /Inject(?:Repository|Model)\(\s*(\w+)/.exec(t.decText)?.[1];
        const gen = /^(?:Repository|EntityRepository|MongoRepository|TreeRepository|Model|ModelType|ReturnModelType)<\s*(?:typeof\s+)?(\w+)/.exec(t.type)?.[1];
        const candidate = inj ?? gen?.replace(/(Document|Doc|Entity)$/, "") ?? null;
        const model = (candidate && (this.modelByName(candidate, true) ?? this.modelByName(candidate))) || (/Repository$/.test(t.type) ? this.modelByName(t.type) : null);
        if (model) map.set(t.name, model);
      }
      this.memberModelCache.set(cls, map);
    }
    return map.get(member) ?? null;
  }

  /** Mongoose { $set: data } -> data */
  private unwrapSet(e: ts.Expression): ts.Expression {
    if (ts.isObjectLiteralExpression(e)) {
      const set = getProp(e, "$set", this.sf);
      if (set) return set;
    }
    return e;
  }

  /** A filter argument: object literal, an id, or unknown. */
  private filterArg(e: ts.Expression | undefined, opts: boolean): DbCall["where"] {
    if (!e) return undefined;
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return "unknown";
    if (ts.isObjectLiteralExpression(e)) {
      if (opts) {
        const w = getProp(e, "where", this.sf);
        if (w !== undefined) return w ?? "unknown";
        const keys = e.properties.map((p) => propName(p, this.sf));
        if (keys.every((k) => k && OPTION_KEYS.has(k))) return hasSpread(e) ? "unknown" : undefined;
      }
      return e;
    }
    if (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e)) return "byId";
    if ((ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e)) && /(^|\.|\b)(_?id|\w*Id|uuid|slug)\b\W*$/i.test(this.text(e).replace(/\(.*\)$/, ""))) return "byId";
    if (ts.isCallExpression(e) && /^(Number|parseInt|String|new\s+ObjectId|ObjectId|new\s+Types\.ObjectId)/.test(this.text(e))) return "byId";
    return "unknown";
  }

  /** repo.findOne(...), Post.findByPk(...), em.findOne(Post, ...), dataSource.getRepository(Post).delete(...) */
  private objectCall(n: ts.CallExpression, p: ts.PropertyAccessExpression, pos: number): DbCall | null {
    const op = p.name.text;
    const spec = OBJECT_METHODS[op];
    if (!spec) return null;
    const recv = p.expression;
    let model: PrismaModel | null = null;
    let args: readonly ts.Expression[] = n.arguments;
    let recvName = this.text(recv);
    if (ts.isCallExpression(recv) && /(^|\.)(getRepository|getCustomRepository|getMongoRepository|getTreeRepository)$/.test(this.text(recv.expression))) {
      const ent = recv.arguments[0];
      model = ent ? this.modelByName(this.text(ent), true) : null;
      recvName = ent ? this.text(ent) : recvName;
      if (!model && !ent) return null;
    } else if (ENTITY_MANAGER.test(recvName.replace(/^this\./, "")) && args[0] && ts.isIdentifier(args[0]) && this.modelByName(args[0].text, true)) {
      model = this.modelByName(args[0].text, true);
      recvName = args[0].text;
      args = args.slice(1);
    } else if (ts.isIdentifier(recv) || ts.isPropertyAccessExpression(recv)) {
      if (ts.isPropertyAccessExpression(recv) && this.clientOk(recv.expression) && this.schema?.byAccessor.get(recv.name.text) && !this.schema.byAccessor.get(recv.name.text)!.source) return null;
      model = (ts.isPropertyAccessExpression(recv) && recv.expression.kind === ts.SyntaxKind.ThisKeyword ? this.memberModel(n, recv.name.text) : null) ?? this.modelByName(recvName);
      if (!model) {
        // Without a known model, only an explicit repository (postRepository.save) counts.
        if (!/(Repository|Repo)$/.test(recvName)) return null;
        if (this.schema && this.schema.models.some((m) => m.source)) return null;
      }
    } else {
      return null;
    }
    let [method, shape] = spec;
    let where: DbCall["where"] = undefined;
    const data: ts.Expression[] = [];
    switch (shape) {
      case "opts":
        where = this.filterArg(args[0], true);
        break;
      case "filter":
        where = this.filterArg(args[0], false);
        break;
      case "id":
        where = args[0] ? "byId" : undefined;
        break;
      case "data":
        if (op === "save" && args[0] && !ts.isObjectLiteralExpression(args[0]) && !ts.isArrayLiteralExpression(args[0]) && this.taint(args[0], this.currentFn!) !== "tainted") return null; // repo.save(entity)
        if (args[0] && ts.isArrayLiteralExpression(args[0])) data.push(...args[0].elements.filter((e) => !ts.isSpreadElement(e)));
        else if (args[0]) data.push(args[0]);
        break;
      case "criteriaData": {
        // Sequelize: update(data, { where }); TypeORM, Mongoose, MikroORM: update(criteria, data)
        const a1 = args[1];
        if (a1 && ts.isObjectLiteralExpression(a1) && getProp(a1, "where", this.sf) !== undefined && model?.source !== "mongoose") {
          where = this.filterArg(a1, true);
          if (args[0]) data.push(this.unwrapSet(args[0]));
        } else {
          where = op === "findByIdAndUpdate" ? "byId" : this.filterArg(args[0], false);
          if (a1) data.push(this.unwrapSet(a1));
          if (!a1 && op === "update") return null; // instance.update(data) (Sequelize) is handled by the earlier read
        }
        break;
      }
      case "remove":
        where = "unknown";
        break;
    }
    if (op === "delete" && !args[0]) return null;
    if (op === "count" && !model) return null;
    const accessor = model?.accessor ?? recvName.replace(/^this\./, "");
    return { node: n, model, accessor, method, pos, label: `${recvName.replace(/^this\./, "")}.${op}()`, orm: "object", where, data, tableRefs: new Set() };
  }

  /** Kysely: db.selectFrom("posts").where("userId", "=", id).executeTakeFirst() */
  private kyselyCall(n: ts.CallExpression, p: ts.PropertyAccessExpression, pos: number): DbCall | null {
    const op = p.name.text;
    if (!(op in KYSELY_ROOTS) || !n.arguments[0]) return null;
    const recv = this.text(p.expression).replace(/^this\./, "");
    if (!this.clientOk(p.expression) && !/^(trx|kysely|tx)$/i.test(recv)) return null;
    const tableArg = n.arguments[0];
    if (!ts.isStringLiteralLike(tableArg)) return null;
    const table = tableArg.text.split(/\s+as\s+/i)[0].trim();
    const steps = chainSteps(n, op);
    const method = op === "selectFrom" && steps.some((s) => /^executeTakeFirst/.test(s.name)) ? "findFirst" : KYSELY_ROOTS[op];
    const data: ts.Expression[] = [];
    for (const s of steps) if ((s.name === "set" || s.name === "values") && s.args[0]) data.push(s.args[0]);
    return this.columnsCall(n, pos, table, method, steps.filter((s) => /^(where|whereRef|orWhere)$/.test(s.name)), data, `${op}("${table}")`);
  }

  /** Knex: knex("posts").where({ id }).update(data) */
  private knexCall(n: ts.CallExpression, tableRaw: string, client: string): DbCall | null {
    const table = tableRaw.split(/\s+as\s+/i)[0].trim();
    const steps = chainSteps(n, client);
    const names = steps.map((s) => s.name);
    const has = (x: string) => names.includes(x);
    const method = has("del") || has("delete") ? "delete" : has("update") ? "update" : has("insert") ? "create" : has("first") ? "findFirst" : "findMany";
    // knex("t") on its own (e.g. passed elsewhere) with no query step is not a query
    if (steps.length === 1) return null;
    const data: ts.Expression[] = [];
    const ws = steps.find((s) => s.name === (method === "update" ? "update" : "insert"));
    if ((method === "update" || method === "create") && ws?.args[0]) data.push(ws.args[0]);
    return this.columnsCall(n, n.getStart(this.sf), table, method, steps.filter((s) => /^(where|andWhere|orWhere|whereIn|whereNull)$/.test(s.name)), data, `${client}("${table}")`);
  }

  private columnsCall(n: ts.CallExpression, pos: number, table: string, method: string, wheres: { args: ts.NodeArray<ts.Expression> }[], data: ts.Expression[], label: string): DbCall | null {
    const model = this.schema?.models.find((m) => m.dbName === table || m.accessor === table) ?? this.schema?.byTable.get(table) ?? null;
    const columns = new Set<string>();
    let unknown = false;
    for (const w of wheres) {
      const a0 = w.args[0];
      if (!a0) continue;
      if (ts.isStringLiteralLike(a0)) columns.add(a0.text.split(".").pop()!);
      else if (ts.isObjectLiteralExpression(a0)) for (const k of keysDeep(a0, this.sf)) columns.add(k.split(".").pop()!);
      else if (ts.isArrowFunction(a0) || ts.isFunctionExpression(a0)) {
        walk(a0, (x) => {
          if (ts.isStringLiteralLike(x)) columns.add(x.text.split(".").pop()!);
        });
        for (const k of keysDeep(a0, this.sf)) columns.add(k);
      } else unknown = true;
    }
    const where: DbCall["where"] = unknown && !columns.size ? "unknown" : wheres.length ? (wheres[0].args[0] ?? "unknown") : undefined;
    return { node: n, model, accessor: model?.accessor ?? table, method, pos, label, orm: "columns", where, data, tableRefs: new Set(), columns };
  }

  /** Comparisons like post.authorId !== session.user.id, at or before `before` (or anywhere when undefined). */
  private ownershipCheck(fn: ts.Node, before?: number): boolean {
    let found = false;
    const fields = [...new Set([...this.config.ownerFields, ...this.config.ownerFields.map(snakeCase), ...(this.schema?.models.flatMap((m) => m.ownerFields) ?? [])])];
    const isOwnerRef = (raw: string) => {
      const s = raw.replace(/(\?\.|\.)(toString|toHexString|valueOf)\(\)$/, "").replace(/\._id$|\.id$/, (m) => (fields.some((f) => raw.includes("." + f + m)) ? "" : m));
      return fields.some((f) => s.endsWith("." + f) || s.endsWith("?." + f));
    };
    walk(fn, (n) => {
      if (found) return;
      if (before !== undefined && n.getStart(this.sf) > before) return;
      if (ts.isBinaryExpression(n)) {
        const op = n.operatorToken.kind;
        if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) {
          if ([this.text(n.left), this.text(n.right)].some(isOwnerRef)) found = true;
        }
      }
      // post.user.equals(req.user._id) (Mongoose ObjectId)
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "equals" && isOwnerRef(this.text(n.expression.expression))) found = true;
    });
    return found;
  }

  /** A read on the same model scoped by an owner key that happens before `pos` (ownership lookup before a write). */
  private ownedLookupBefore(calls: DbCall[], model: PrismaModel, pos: number): boolean {
    return calls.some((c) => c.pos < pos && c.model === model && READ_METHODS.has(c.method) && this.whereScope(c) === "owned");
  }

  private ownerKeys(model: PrismaModel | null): Set<string> {
    const base = [...this.config.ownerFields, ...(model?.ownerFields ?? []), ...(model?.ownerRelations ?? [])];
    const dbNames = model ? model.fields.filter((f) => model.ownerFields.includes(f.name)).map((f) => f.dbName) : [];
    return new Set([...base, ...base.map(snakeCase), ...dbNames]);
  }

  /** "owned" | "unscoped" | "public" | "none" (no where) | "unknown" (where is not a literal) */
  private whereScope(call: DbCall): "owned" | "unscoped" | "public" | "none" | "unknown" {
    const w = call.where;
    if (w === "unknown") return "unknown";
    if (w === undefined) return "none";
    if (w === "byId") return "unscoped";
    const owner = this.ownerKeys(call.model);
    const markers = this.config.publicReadMarkers;
    if (call.orm === "columns") {
      const cols = [...(call.columns ?? [])];
      if (cols.some((k) => owner.has(k))) return "owned";
      if (cols.some((k) => markers.includes(k) || markers.includes(camelCase(k)))) return "public";
      return cols.length ? "unscoped" : "unknown";
    }
    if (call.orm === "prisma" || call.orm === "object") {
      if (!ts.isObjectLiteralExpression(w)) return "unknown";
      const keys = keysDeep(w, this.sf);
      if ([...keys].some((k) => owner.has(k))) return "owned";
      if ([...keys].some((k) => markers.includes(k))) return "public";
      if (hasSpread(w)) return "unknown";
      return "unscoped";
    }
    // Drizzle: and(eq(posts.id, id), eq(posts.authorId, userId)), (posts, { eq }) => ..., or an object filter
    const refs = new Set(call.tableRefs);
    let expr: ts.Node = w;
    if (ts.isArrowFunction(w) || ts.isFunctionExpression(w)) {
      const p0 = w.parameters[0];
      if (p0 && ts.isIdentifier(p0.name)) refs.add(p0.name.text);
      expr = w.body;
    }
    if (ts.isIdentifier(expr)) return "unknown";
    const names = new Set<string>();
    let template = false;
    walk(expr, (n) => {
      if (ts.isPropertyAccessExpression(n)) {
        const obj = n.expression;
        const objName = ts.isIdentifier(obj) ? obj.text : ts.isPropertyAccessExpression(obj) ? obj.name.text : "";
        if (refs.has(objName)) names.add(n.name.text);
      }
      if (ts.isTaggedTemplateExpression(n)) template = true;
    });
    keysDeep(expr, this.sf, names);
    if ([...names].some((k) => owner.has(k))) return "owned";
    if (template) {
      const t = this.text(expr);
      const cols = call.model ? call.model.ownerFields.flatMap((f) => [f, call.model!.fields.find((x) => x.name === f)?.dbName ?? f]) : [];
      return cols.some((c) => t.includes(c)) ? "owned" : "unknown";
    }
    if ([...names].some((k) => markers.includes(k))) return "public";
    if (hasSpread(expr)) return "unknown";
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
      if (this.validated.has(name)) return "validated";
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

  /** Who authenticated this entry: a wrapper or middleware, an auth call in the body, or route middleware. */
  authOf(entry: Entry, middlewareAuthed: boolean): string | null {
    return entry.authedBy ?? this.authCall(entry.fn) ?? (middlewareAuthed ? "middleware" : null);
  }

  /** Does this function compare an owner field with the current user anywhere? */
  hasOwnershipCheck(fn: ts.Node): boolean {
    return this.ownershipCheck(fn);
  }

  /** this.postsService.remove(id) calls in a class method: member name -> methods called */
  serviceCalls(fn: ts.Node): { member: string; method: string }[] {
    const out: { member: string; method: string }[] = [];
    walk(fn, (n) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isPropertyAccessExpression(n.expression.expression) && n.expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
        out.push({ member: n.expression.expression.name.text, method: n.expression.name.text });
      }
    });
    return out;
  }

  analyze(entry: Entry, middlewareAuthed: boolean, opts: { ownershipElsewhere?: boolean } = {}): Finding[] {
    const findings: Finding[] = [];
    const fn = entry.fn;
    const where =
      entry.kind === "server-action"
        ? `Server action ${entry.name}`
        : entry.kind === "express"
          ? `Route ${entry.name}`
          : entry.kind === "trpc"
            ? `tRPC procedure ${entry.name}`
            : entry.kind === "graphql"
              ? `GraphQL resolver ${entry.name}`
              : entry.kind === "nest"
                ? `${entry.name}${entry.routePath ? ` (${entry.routePath})` : ""}`
                : `${entry.name} ${entry.routePath ?? ""}`.trim();
    this.validated = new Set(entry.validated ?? []);
    this.currentFn = fn;
    const auth = this.authOf(entry, middlewareAuthed);
    const calls = this.dbCalls(fn);
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
            `${where} calls ${target.label} but never checks who the caller is.${entry.kind === "server-action" ? " Server actions are public HTTP endpoints: anyone can call them directly." : entry.kind === "trpc" ? " It is built on a public procedure, so anyone can call it." : ""}`,
            entry.kind === "trpc"
              ? "Build it on your authenticated procedure (for example protectedProcedure instead of publicProcedure) and scope the query to ctx.session.user.id."
              : entry.kind === "nest"
                ? "Protect it with your auth guard (@UseGuards(JwtAuthGuard) on the method or controller, or a global APP_GUARD) and scope the query to the current user. If it is meant to be public, mark it with your @Public() decorator."
                : entry.kind === "graphql"
                  ? "Check the user from the context first (if (!context.user) throw new GraphQLError(\"Unauthorized\", { extensions: { code: \"UNAUTHENTICATED\" } })) and scope the query to context.user.id."
                  : entry.kind === "file-route"
                    ? "Read the user from the request first (e.g. event.locals.user, getUserSession(event), or requireUserId(request)) and reject anonymous callers, then scope the query to that user. If this endpoint is meant to be public, add it to publicRoutes in safegate.config.json."
                    : `Get the session at the top (e.g. const session = await auth(); if (!session) throw new Error("Unauthorized")) and scope the query to session.user.id. If this endpoint is meant to be public, add it to publicRoutes in safegate.config.json.`,
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
          if (opts.ownershipElsewhere || this.ownershipCheck(fn)) continue;
          if (isPublic) continue;
          findings.push(
            make(
              "AUTH002",
              this.rel,
              lineOfNode(this.sf, call.node),
              scope === "none"
                ? `${where} runs ${call.label} with no filter on ${model.name}, which is owned by ${ownerHint}: it returns every user's rows.`
                : `${where} loads ${model.name} via ${call.label} without filtering by ${ownerHint} and never compares ${ownerHint} to the current user. Any logged-in user can read another user's ${model.name} by changing the id.`,
              call.orm === "drizzle"
                ? `Add the owner to the filter, e.g. .where(and(eq(${model.accessor}.id, id), eq(${model.accessor}.${ownerHint}, session.user.id))), or compare ${ownerHint} with the current user before returning the row.`
                : call.orm === "prisma"
                  ? `Add ${ownerHint}: session.user.id to the where clause (Prisma 5+ allows non-unique filters in findUnique/update/delete), or check ${model.accessor}.${ownerHint} === session.user.id before returning it.`
                  : `${scopedExample(call, ownerHint)}, or compare ${ownerHint} with the current user before returning the row.`
            )
          );
        }
        if (SCOPED_WRITES.has(call.method) && (scope === "unscoped" || scope === "none" || scope === "public")) {
          if (opts.ownershipElsewhere || this.ownershipCheck(fn, call.pos) || this.ownedLookupBefore(calls, model, call.pos)) continue;
          findings.push(
            make(
              "AUTH003",
              this.rel,
              lineOfNode(this.sf, call.node),
              `${where} runs ${call.label} on ${model.name} without scoping it to ${ownerHint}. Any logged-in user can ${call.method.startsWith("delete") ? "delete" : "modify"} another user's ${model.name} by changing the id.`,
              call.orm === "drizzle"
                ? `Scope the filter to the owner, e.g. .where(and(eq(${model.accessor}.id, id), eq(${model.accessor}.${ownerHint}, session.user.id))), or load the row scoped to the user first and return 404 if it is not found.`
                : call.orm === "prisma"
                  ? `Add ${ownerHint}: session.user.id to the where clause, e.g. where: { id, ${ownerHint}: session.user.id }, or load the record scoped to the user first and return 404 if it is not found.`
                  : `${scopedExample(call, ownerHint)}, or load the record scoped to the user first and return 404 if it is not found.`
            )
          );
        }
      }
    }

    // AUTH004 mass assignment
    for (const call of calls) {
      if (!DATA_WRITES.has(call.method)) continue;
      for (const data of call.data) {
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
            `${where} passes request input (${this.text(risky).slice(0, 60)}) straight into ${call.label}.${sensitive.length ? ` ${call.model!.name} has sensitive fields (${sensitive.join(", ")}) that a caller could set.` : ""}`,
            "Validate with a schema that lists only the allowed fields (e.g. zod: const input = UpdateSchema.parse(body)) or copy fields explicitly: { title: body.title, content: body.content }.",
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
          entry.kind === "nest"
            ? `Add a role check, e.g. @UseGuards(JwtAuthGuard, RolesGuard) with @Roles(Role.Admin), or check user.role in the handler and throw ForbiddenException.`
            : entry.kind === "trpc"
            ? `Build it on a procedure that checks the role (for example adminProcedure), or throw new TRPCError({ code: "FORBIDDEN" }) when ctx.session.user.role is not an admin.`
            : `Check the role after authentication, e.g. if (session.user.role !== "ADMIN") return new Response("Forbidden", { status: 403 }).`
        )
      );
    }

    return findings;
  }
}

/** How to write an owner-scoped filter in the ORM this call uses. */
function scopedExample(call: DbCall, owner: string): string {
  const col = call.model?.fields.find((f) => f.name === owner)?.dbName ?? owner;
  const user = "currentUser.id";
  if (call.orm === "columns") return call.label.startsWith("knex") || /^\w+\("/.test(call.label) && !/^(selectFrom|updateTable|deleteFrom|insertInto)/.test(call.label) ? `Add the owner to the query, e.g. .where({ id, ${col}: ${user} })` : `Add the owner to the query, e.g. .where("id", "=", id).where("${col}", "=", ${user})`;
  const src = call.model?.source;
  if (src === "mongoose") return `Filter by the owner too, e.g. findOne({ _id: id, ${owner}: ${user} }) instead of findById(id)`;
  if (src === "sequelize") return `Filter by the owner too, e.g. findOne({ where: { id, ${owner}: ${user} } }) instead of findByPk(id)`;
  const rel = call.model?.ownerRelations.includes(owner);
  return `Filter by the owner too, e.g. findOne({ where: { id, ${owner}: ${rel ? `{ id: ${user} }` : user} } })`;
}

function camelCase(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function globMatch(glob: string, value: string): boolean {
  return globToRegExp(glob).test(value);
}
