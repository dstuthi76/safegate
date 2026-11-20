import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface RepoSpec {
  owner: string;
  repo: string;
  ref: string | null;
}

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9_])?$/;

/** Accepts "owner/repo", "github.com/owner/repo", a full https URL, optionally with /tree/<branch>. Public GitHub only. */
export function parseRepo(input: string): RepoSpec | null {
  let s = String(input || "").trim();
  if (s.length > 300) return null;
  const hadProtocol = /^https?:\/\//i.test(s);
  s = s.replace(/^https?:\/\//i, "");
  if (hadProtocol && !/^(www\.)?github\.com\//i.test(s)) return null;
  s = s.replace(/^(www\.)?github\.com\//i, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  const m = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/tree\/(.+))?$/.exec(s);
  if (!m) return null;
  const [, owner, repo, ref] = m;
  if (!OWNER.test(owner) || !NAME.test(repo) || repo === "." || repo === "..") return null;
  if (ref !== undefined && (!/^[\w.\-/]{1,120}$/.test(ref) || ref.includes(".."))) return null;
  return { owner, repo, ref: ref ?? null };
}

const MAX_TARBALL_BYTES = 80 * 1024 * 1024;

/** Downloads a public repo snapshot as a tarball and unpacks it into destDir. Nothing in it is ever executed. */
export async function downloadRepo(spec: RepoSpec, destDir: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const base = env.SAFEGATE_GITHUB_API_BASE || "https://api.github.com";
  const url = `${base}/repos/${spec.owner}/${spec.repo}/tarball${spec.ref ? "/" + spec.ref.split("/").map(encodeURIComponent).join("/") : ""}`;
  const headers: Record<string, string> = { "User-Agent": "safegate", Accept: "application/vnd.github+json" };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

  const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (res.status === 404) throw new Error("Repository or branch not found. Only public GitHub repositories can be scanned here.");
  if (res.status === 403 || res.status === 429) throw new Error("GitHub rate limit reached. Try again in a few minutes.");
  if (!res.ok || !res.body) throw new Error(`GitHub returned ${res.status}`);

  const tarball = path.join(destDir, "..", path.basename(destDir) + ".tar.gz");
  const out = fs.createWriteStream(tarball);
  let bytes = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_TARBALL_BYTES) {
        await reader.cancel();
        throw new Error("Repository is too large for the web scanner (limit 80 MB). Use the CLI or GitHub Action instead.");
      }
      if (!out.write(value)) await new Promise((r) => out.once("drain", r));
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    fs.mkdirSync(destDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      execFile("tar", ["-xzf", tarball, "-C", destDir, "--strip-components=1", "--no-same-owner", "--no-same-permissions"], { timeout: 60_000 }, (err) =>
        err ? reject(new Error("Could not unpack the repository archive.")) : resolve()
      );
    });
    removeSymlinks(destDir);
  } finally {
    out.destroy();
    fs.rmSync(tarball, { force: true });
  }
}

/** Symlinks in an untrusted archive could point at files outside it, so they are removed before scanning. */
function removeSymlinks(dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) fs.rmSync(p, { force: true });
    else if (e.isDirectory()) removeSymlinks(p);
  }
}
