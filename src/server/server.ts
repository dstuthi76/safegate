import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { createWorkspace, FIXABLE_RULES, FixProposal, proposeFix } from "../ai/fix";
import { geminiConfigFromEnv } from "../ai/gemini";
import { run, VERSION } from "../index";
import { Finding } from "../types";
import { downloadRepo, parseRepo } from "./github";
import { StatsStore, storeFromEnv } from "./store";

const WEB_DIR = path.resolve(__dirname, "../../../web");
const DEMO_DIR = path.resolve(__dirname, "../../../examples/demo-app");
const WORKSPACE_TTL_MS = 20 * 60 * 1000;
const MAX_WORKSPACES = 25;
const MAX_BODY = 20_000;

interface Workspace {
  id: string;
  dir: string;
  label: string;
  findings: Finding[];
  created: number;
  fixes: Map<number, Promise<FixProposal>>;
  /** Fixes run one at a time per workspace because verification patches files in place. */
  queue: Promise<unknown>;
  fixCount: number;
}

class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private limit: number, private windowMs: number) {}
  allow(key: string): boolean {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 5000) this.hits.clear();
    return true;
  }
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function snippet(dir: string, f: Finding): { line: number; text: string }[] {
  try {
    const lines = fs.readFileSync(path.join(dir, f.file), "utf8").split("\n");
    const out = [];
    for (let n = Math.max(1, f.line - 2); n <= Math.min(lines.length, f.line + 2); n++) out.push({ line: n, text: lines[n - 1].slice(0, 220) });
    return out;
  } catch {
    return [];
  }
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {
    /* fall through */
  }
  throw new HttpError(400, "Body must be a JSON object");
}

const STATIC: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"]
};

export function createApp(env: NodeJS.ProcessEnv = process.env, store: StatsStore = storeFromEnv(env)) {
  const workspaces = new Map<string, Workspace>();
  const scanLimiter = new RateLimiter(Number(env.SAFEGATE_SCANS_PER_10MIN || 12), 10 * 60 * 1000);
  const fixLimiter = new RateLimiter(Number(env.SAFEGATE_FIXES_PER_10MIN || 40), 10 * 60 * 1000);
  const maxFixesPerScan = Number(env.SAFEGATE_FIXES_PER_SCAN || 25);
  let activeScans = 0;

  const dropWorkspace = (ws: Workspace) => {
    workspaces.delete(ws.id);
    // Wait for any running fix before deleting the files.
    ws.queue.finally(() => fs.rmSync(ws.dir, { recursive: true, force: true }));
  };
  const sweep = () => {
    const now = Date.now();
    for (const ws of [...workspaces.values()]) if (now - ws.created > WORKSPACE_TTL_MS) dropWorkspace(ws);
    while (workspaces.size > MAX_WORKSPACES) dropWorkspace([...workspaces.values()].sort((a, b) => a.created - b.created)[0]);
  };
  const timer = setInterval(sweep, 60_000);
  timer.unref();

  const bump = (delta: Record<string, number>) => store.add(delta).catch((e) => console.error(`stats: ${(e as Error).message}`));

  async function scan(body: Record<string, unknown>): Promise<unknown> {
    if (activeScans >= 3) throw new HttpError(503, "The scanner is busy. Try again in a moment.");
    activeScans++;
    try {
      let dir: string;
      let label: string;
      if (body.demo === true) {
        dir = createWorkspace(DEMO_DIR).dir;
        label = "demo app (17 planted bugs)";
      } else {
        const spec = parseRepo(String(body.repo ?? ""));
        if (!spec) throw new HttpError(400, "Enter a public GitHub repository, for example https://github.com/owner/repo");
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "safegate-repo-"));
        label = `${spec.owner}/${spec.repo}${spec.ref ? "@" + spec.ref : ""}`;
        try {
          await downloadRepo(spec, dir, env);
        } catch (e) {
          fs.rmSync(dir, { recursive: true, force: true });
          throw new HttpError(422, (e as Error).message);
        }
        // A config file inside a stranger's repo must not switch rules off or point outside the repo.
        fs.rmSync(path.join(dir, "safegate.config.json"), { force: true });
      }
      let summary;
      try {
        summary = run({ root: dir });
      } catch (e) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new HttpError(422, `Could not scan this repository: ${(e as Error).message}`);
      }
      const ws: Workspace = { id: crypto.randomBytes(12).toString("hex"), dir, label, findings: summary.findings, created: Date.now(), fixes: new Map(), queue: Promise.resolve(), fixCount: 0 };
      workspaces.set(ws.id, ws);
      sweep();
      const delta: Record<string, number> = { scans: 1, findings: summary.findings.length };
      for (const f of summary.findings) delta[`rule_${f.ruleId}`] = (delta[`rule_${f.ruleId}`] ?? 0) + 1;
      bump(delta);
      return {
        scanId: ws.id,
        repo: label,
        entriesChecked: summary.entriesChecked,
        migrationsChecked: summary.migrationsChecked,
        schemaFound: summary.schemaFound,
        expiresInMinutes: WORKSPACE_TTL_MS / 60000,
        findings: summary.findings.map((f, index) => ({ index, ...f, fixable: FIXABLE_RULES.has(f.ruleId), snippet: snippet(dir, f) }))
      };
    } finally {
      activeScans--;
    }
  }

  async function fix(body: Record<string, unknown>): Promise<unknown> {
    const cfg = geminiConfigFromEnv(env);
    if (!cfg) throw new HttpError(503, "Gemini is not configured on this server.");
    const ws = workspaces.get(String(body.scanId ?? ""));
    if (!ws) throw new HttpError(410, "This scan has expired. Run the scan again.");
    const index = Number(body.index);
    const finding = Number.isInteger(index) ? ws.findings[index] : undefined;
    if (!finding) throw new HttpError(400, "Unknown finding");
    let job = ws.fixes.get(index);
    if (!job) {
      if (ws.fixCount >= maxFixesPerScan) throw new HttpError(429, "Fix limit for this scan reached. Use the CLI for the rest.");
      ws.fixCount++;
      job = ws.queue.then(() => proposeFix(ws.dir, finding, ws.findings, cfg));
      ws.queue = job.catch(() => undefined);
      ws.fixes.set(index, job);
      job.then((p) => {
        if (p.status === "verified") bump({ fixesVerified: 1 });
        if (p.status === "error") ws.fixes.delete(index); // allow a retry
      });
    }
    const p = await job;
    return { index, status: p.status, reason: p.reason ?? null, explanation: p.explanation, impact: p.impact, diff: p.diff, attempts: p.attempts, model: p.model ?? null };
  }

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url || "/", "http://localhost");
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        res.writeHead(200, {
          "Content-Type": type,
          "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer"
        });
        res.end(fs.readFileSync(path.join(WEB_DIR, file)));
        return;
      }
      if (req.method === "GET" && url.pathname === "/healthz") return send(200, { ok: true });
      if (req.method === "GET" && url.pathname === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/config") {
        const cfg = geminiConfigFromEnv(env);
        return send(200, { version: VERSION, ai: !!cfg, model: cfg?.models[0] ?? null, aiMode: cfg?.mode ?? null });
      }
      if (req.method === "GET" && url.pathname === "/api/stats") return send(200, await store.read());
      if (req.method === "POST" && url.pathname === "/api/scan") {
        if (!scanLimiter.allow(ip)) throw new HttpError(429, "Too many scans from this address. Try again in a few minutes.");
        return send(200, await scan(await readJson(req)));
      }
      if (req.method === "POST" && url.pathname === "/api/fix") {
        if (!fixLimiter.allow(ip)) throw new HttpError(429, "Too many fix requests. Try again in a few minutes.");
        return send(200, await fix(await readJson(req)));
      }
      send(404, { error: "Not found" });
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      console.error(e);
      send(500, { error: "Internal error" });
    }
  };

  const close = () => {
    clearInterval(timer);
    for (const ws of [...workspaces.values()]) dropWorkspace(ws);
  };
  return { handler, close };
}

export function startServer(port: number, env: NodeJS.ProcessEnv = process.env): Promise<http.Server & { closeApp: () => void }> {
  const app = createApp(env);
  const server = http.createServer(app.handler) as http.Server & { closeApp: () => void };
  server.closeApp = app.close;
  return new Promise((resolve) => {
    server.listen(port, () => {
      const cfg = geminiConfigFromEnv(env);
      console.log(`safegate ${VERSION} listening on :${port} (Gemini: ${cfg ? `${cfg.mode}, ${cfg.models[0]}` : "not configured"})`);
      resolve(server);
    });
  });
}
