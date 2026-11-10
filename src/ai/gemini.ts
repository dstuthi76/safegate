/**
 * Minimal Gemini client over REST (no SDK dependency).
 *
 * Two ways to authenticate, picked automatically:
 *  1. Gemini API key   - set GEMINI_API_KEY (from Google AI Studio). Used by the CLI and GitHub Action.
 *  2. Vertex AI        - on Cloud Run (or anywhere with GOOGLE_CLOUD_PROJECT + GOOGLE_GENAI_USE_VERTEXAI=true)
 *                        the service account token comes from the metadata server. No key to manage.
 */

export const DEFAULT_MODELS = ["gemini-3.8-flash", "gemini-3.6-flash"];

export interface GeminiConfig {
  mode: "apikey" | "vertex";
  /** Models to try in order; the next one is used if a model is not found (404). */
  models: string[];
  apiKey?: string;
  project?: string;
  location?: string;
  /** Override for tests or proxies */
  baseUrl?: string;
  timeoutMs: number;
}

export class GeminiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export function geminiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GeminiConfig | null {
  const models = env.SAFEGATE_GEMINI_MODEL ? env.SAFEGATE_GEMINI_MODEL.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_MODELS;
  const timeoutMs = Number(env.SAFEGATE_GEMINI_TIMEOUT_MS || 90000);
  const baseUrl = env.SAFEGATE_GEMINI_BASE_URL || undefined;
  const useVertex = /^(1|true)$/i.test(env.GOOGLE_GENAI_USE_VERTEXAI || "");
  const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  if (apiKey && !useVertex) return { mode: "apikey", models, apiKey, baseUrl, timeoutMs };
  const project = env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT;
  if (project && (useVertex || env.K_SERVICE)) {
    return { mode: "vertex", models, project, location: env.GOOGLE_CLOUD_LOCATION || "global", baseUrl, timeoutMs };
  }
  return null;
}

let cachedToken: { token: string; expires: number } | null = null;

/** Access token for Google APIs: GOOGLE_ACCESS_TOKEN (local dev) or the Cloud Run metadata server. */
export async function googleAccessToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env.GOOGLE_ACCESS_TOKEN) return env.GOOGLE_ACCESS_TOKEN;
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.token;
  const host = env.GCE_METADATA_HOST || "metadata.google.internal";
  const res = await fetch(`http://${host}/computeMetadata/v1/instance/service-accounts/default/token`, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(5000)
  });
  if (!res.ok) throw new GeminiError(`Could not get a service account token from the metadata server (${res.status})`, res.status);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

function endpoint(cfg: GeminiConfig, model: string): string {
  if (cfg.mode === "apikey") {
    const base = cfg.baseUrl || "https://generativelanguage.googleapis.com";
    return `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  }
  const loc = cfg.location || "global";
  const base = cfg.baseUrl || (loc === "global" ? "https://aiplatform.googleapis.com" : `https://${loc}-aiplatform.googleapis.com`);
  return `${base}/v1/projects/${cfg.project}/locations/${loc}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface JsonRequest {
  system: string;
  prompt: string;
  /** Response schema in Gemini's OpenAPI-subset format (types in upper case) */
  schema: Record<string, unknown>;
}

export interface JsonResult<T> {
  data: T;
  model: string;
}

/** Sends one prompt and returns the parsed JSON object that matches `schema`. */
export async function generateJson<T>(cfg: GeminiConfig, req: JsonRequest): Promise<JsonResult<T>> {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: "user", parts: [{ text: req.prompt }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: req.schema }
  });

  let lastError: GeminiError = new GeminiError("No Gemini model configured");
  for (const model of cfg.models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (cfg.mode === "apikey") headers["x-goog-api-key"] = cfg.apiKey!;
      else headers["Authorization"] = `Bearer ${await googleAccessToken()}`;

      let res: Response;
      try {
        res = await fetch(endpoint(cfg, model), { method: "POST", headers, body, signal: AbortSignal.timeout(cfg.timeoutMs) });
      } catch (e) {
        lastError = new GeminiError(`Gemini request failed: ${(e as Error).message}`);
        await sleep(500 * (attempt + 1));
        continue;
      }
      if (res.status === 404) {
        lastError = new GeminiError(`Model ${model} was not found`, 404);
        break; // try the next model
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new GeminiError(`Gemini returned ${res.status}`, res.status);
        await sleep(800 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        let msg = text.slice(0, 300);
        try {
          msg = JSON.parse(text).error?.message ?? msg;
        } catch {
          /* keep raw text */
        }
        throw new GeminiError(`Gemini returned ${res.status}: ${msg}`, res.status);
      }
      const json = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
        promptFeedback?: { blockReason?: string };
      };
      if (json.promptFeedback?.blockReason) throw new GeminiError(`Gemini blocked the request: ${json.promptFeedback.blockReason}`);
      const cand = json.candidates?.[0];
      const text = (cand?.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
      if (!text) throw new GeminiError(`Gemini returned no text (finishReason: ${cand?.finishReason ?? "unknown"})`);
      try {
        return { data: JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "")) as T, model };
      } catch {
        throw new GeminiError("Gemini returned text that is not valid JSON");
      }
    }
  }
  throw lastError;
}
