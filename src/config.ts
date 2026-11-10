import * as fs from "fs";
import * as path from "path";

export interface SafegateConfig {
  /** Paths (globs, relative to root) that are never scanned */
  ignore: string[];
  /** Schema field names that mark a row as belonging to a user/tenant */
  ownerFields: string[];
  /** Function names whose call proves the caller is authenticated */
  authFunctions: string[];
  /** Wrapper functions that add authentication around a handler, e.g. withAuth(handler) */
  authWrappers: string[];
  /** Express middleware names that enforce authentication */
  authMiddleware: string[];
  /** Variable names used for the Prisma client */
  prismaClientNames: string[];
  /** Route paths (globs) that are intentionally public, e.g. webhooks */
  publicRoutes: string[];
  /** Model fields that must never be set straight from request input */
  sensitiveFields: string[];
  /** Identifier fragments that count as a role / permission check in admin handlers */
  roleCheckPatterns: string[];
  /** Where-clause keys that mark a read as intentionally public (e.g. published posts) */
  publicReadMarkers: string[];
  /** Explicit path to schema.prisma (auto-detected when empty) */
  schemaPath: string;
  /** Explicit path to the Prisma migrations folder (auto-detected when empty) */
  migrationsDir: string;
  /** Rule ids to disable entirely */
  disabledRules: string[];
}

export const DEFAULT_CONFIG: SafegateConfig = {
  ignore: ["node_modules/**", ".next/**", "dist/**", "build/**", "coverage/**", "**/*.test.ts", "**/*.spec.ts", "**/__tests__/**"],
  ownerFields: ["userId", "ownerId", "authorId", "creatorId", "createdById", "accountId", "orgId", "organizationId", "tenantId", "workspaceId", "teamId"],
  authFunctions: [
    "auth",
    "getServerSession",
    "getSession",
    "getServerAuthSession",
    "currentUser",
    "getCurrentUser",
    "getUser",
    "requireAuth",
    "requireUser",
    "requireSession",
    "requireAdmin",
    "validateRequest",
    "getAuth",
    "verifySession",
    "auth.getUser",
    "auth.getSession",
    "auth.protect"
  ],
  authWrappers: ["withAuth", "withApiAuthRequired", "withPageAuthRequired", "authenticated", "protectedRoute", "withSession", "authedAction", "protectedAction"],
  authMiddleware: ["requireAuth", "authenticate", "isAuthenticated", "ensureAuthenticated", "ensureLoggedIn", "authMiddleware", "verifyToken", "requireUser", "passport.authenticate", "protect", "auth"],
  prismaClientNames: ["prisma", "db", "client", "tx", "prismaClient"],
  publicRoutes: ["**/api/auth/**", "**/webhook/**", "**/webhooks/**", "**/api/health/**", "**/api/public/**", "**/api/cron/**"],
  sensitiveFields: ["role", "roles", "isAdmin", "admin", "permissions", "plan", "credits", "balance", "emailVerified", "isVerified", "stripeCustomerId", "subscriptionStatus"],
  roleCheckPatterns: ["role", "isAdmin", "permission", "hasRole", "authorize", "requireAdmin", "ability", "can"],
  publicReadMarkers: ["published", "isPublic", "public", "visibility", "isPublished"],
  schemaPath: "",
  migrationsDir: "",
  disabledRules: []
};

export const CONFIG_FILE = "safegate.config.json";

/** Loads safegate.config.json from the root. Arrays in the user file extend the defaults unless "replace": true is set. */
export function loadConfig(root: string): SafegateConfig {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
  let user: Record<string, unknown>;
  try {
    user = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`Could not parse ${CONFIG_FILE}: ${(e as Error).message}`);
  }
  const replace = user.replace === true;
  const merged: Record<string, unknown> = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(user)) {
    if (key === "replace") continue;
    if (!(key in DEFAULT_CONFIG)) {
      throw new Error(`Unknown option "${key}" in ${CONFIG_FILE}`);
    }
    const base = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key];
    if (Array.isArray(base) && Array.isArray(value) && !replace) {
      merged[key] = Array.from(new Set([...base, ...value]));
    } else {
      merged[key] = value;
    }
  }
  return merged as unknown as SafegateConfig;
}
