import { googleAccessToken } from "../ai/gemini";

/**
 * Usage counters only: number of scans, findings per rule, verified fixes.
 * No repository names and no code are stored.
 * On Google Cloud (SAFEGATE_FIRESTORE=1) counters live in Firestore document stats/global;
 * elsewhere they are kept in memory.
 */
export interface Stats {
  scans: number;
  findings: number;
  fixesVerified: number;
  byRule: Record<string, number>;
}

export interface StatsStore {
  add(delta: Record<string, number>): Promise<void>;
  read(): Promise<Stats>;
}

function toStats(flat: Record<string, number>): Stats {
  const byRule: Record<string, number> = {};
  for (const [k, v] of Object.entries(flat)) if (k.startsWith("rule_")) byRule[k.slice(5)] = v;
  return { scans: flat.scans ?? 0, findings: flat.findings ?? 0, fixesVerified: flat.fixesVerified ?? 0, byRule };
}

export class MemoryStore implements StatsStore {
  private flat: Record<string, number> = {};
  async add(delta: Record<string, number>) {
    for (const [k, v] of Object.entries(delta)) this.flat[k] = (this.flat[k] ?? 0) + v;
  }
  async read() {
    return toStats(this.flat);
  }
}

export class FirestoreStore implements StatsStore {
  private base: string;
  private doc: string;
  constructor(project: string, database = "(default)", baseUrl = "https://firestore.googleapis.com") {
    this.doc = `projects/${project}/databases/${database}/documents/stats/global`;
    this.base = `${baseUrl}/v1/projects/${project}/databases/${database}/documents`;
  }
  private async headers() {
    return { Authorization: `Bearer ${await googleAccessToken()}`, "Content-Type": "application/json" };
  }
  /** Atomic server-side increments, so concurrent Cloud Run instances do not lose updates. */
  async add(delta: Record<string, number>) {
    const fieldTransforms = Object.entries(delta).map(([fieldPath, n]) => ({ fieldPath, increment: { integerValue: String(n) } }));
    const res = await fetch(`${this.base}:commit`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({ writes: [{ transform: { document: this.doc, fieldTransforms } }] }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error(`Firestore commit failed: ${res.status}`);
  }
  async read() {
    const res = await fetch(`${this.base}/stats/global`, { headers: await this.headers(), signal: AbortSignal.timeout(8000) });
    if (res.status === 404) return toStats({});
    if (!res.ok) throw new Error(`Firestore read failed: ${res.status}`);
    const body = (await res.json()) as { fields?: Record<string, { integerValue?: string }> };
    const flat: Record<string, number> = {};
    for (const [k, v] of Object.entries(body.fields ?? {})) flat[k] = Number(v.integerValue ?? 0);
    return toStats(flat);
  }
}

export function storeFromEnv(env: NodeJS.ProcessEnv = process.env): StatsStore {
  const project = env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT;
  if (/^(1|true)$/i.test(env.SAFEGATE_FIRESTORE || "") && project) {
    return new FirestoreStore(project, env.SAFEGATE_FIRESTORE_DATABASE || "(default)", env.SAFEGATE_FIRESTORE_BASE_URL);
  }
  return new MemoryStore();
}
