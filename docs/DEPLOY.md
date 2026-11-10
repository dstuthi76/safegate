# Deploying safegate on Google Cloud

The web service runs on **Cloud Run**, calls **Gemini on Vertex AI** with the service's own identity (no API key), and keeps usage counters in **Firestore**. `gcloud run deploy --source` builds the image with **Cloud Build** and stores it in **Artifact Registry**.

| Google service | What safegate uses it for |
|---|---|
| Gemini (`gemini-3.8-flash`, fallback `gemini-3.6-flash`) | Writes the patch for each finding, with a JSON response schema |
| Vertex AI | Serves Gemini to Cloud Run with IAM auth, no key to store |
| Cloud Run | Hosts the scanner and web page; scales to zero when idle |
| Firestore | Atomic usage counters (scans, findings per rule, verified fixes) |
| Cloud Build + Artifact Registry | Build and store the container image |
| Google AI Studio | API key for the CLI and the GitHub Action (`GEMINI_API_KEY`) |

## 1. One-time setup (about 10 minutes)

1. Create a Google Cloud project and turn on billing: <https://console.cloud.google.com/projectcreate>
2. Install the gcloud CLI: <https://cloud.google.com/sdk/docs/install>
3. Log in and pick the project:
   ```bash
   gcloud auth login
   gcloud config set project YOUR_PROJECT_ID
   ```

## 2. Deploy

```bash
PROJECT_ID=YOUR_PROJECT_ID ./deploy/deploy.sh
```

The script enables the APIs, creates a least-privilege service account (`roles/aiplatform.user`, `roles/datastore.user`), creates the Firestore database if missing, builds, deploys, and calls `/healthz` and `/api/config` on the live URL.

Expected last lines:

```
{"ok":true}
{"version":"0.2.0","ai":true,"model":"gemini-3.8-flash","aiMode":"vertex"}
Live at: https://safegate-xxxxxxxx.a.run.app
```

Options (environment variables): `REGION` (default `asia-south1`, Mumbai), `SERVICE`, `MODEL`, `GITHUB_TOKEN`.

## 3. Check the live service

1. Open the URL and click **Try the demo app**. Expect **17 findings**.
2. On the `AUTH003` card click **Fix with Gemini**. Expect a green **Verified fix** with a one-line diff that adds `authorId: session.user.id`.
3. Paste a public Next.js + Prisma repository URL and scan it.
4. `curl https://YOUR_URL/api/stats` should show the counters rising, and the Firestore console should show the document `stats/global`.

## 4. If something fails

| Symptom | Cause and fix |
|---|---|
| `"ai": false` in `/api/config` | Env vars missing. Re-run the deploy script. |
| Fix returns "Model ... was not found" | The model is not available to your project or region. Check the current list at <https://aistudio.google.com/docs/models> and redeploy with `MODEL=<name>`. |
| Fix returns 403 | The service account lacks `roles/aiplatform.user`, or the Vertex AI API is off. |
| "GitHub rate limit reached" | Unauthenticated GitHub downloads are limited per IP. Redeploy with `GITHUB_TOKEN=<a token with no scopes>`. For production keep it in Secret Manager: `--set-secrets GITHUB_TOKEN=github-token:latest`. |
| "This scan has expired" right after scanning | A second instance answered. Keep `--max-instances 1` (see below). |
| `stats:` errors in logs | Firestore database missing or the role is not bound. Stats failing never blocks a scan. |

Logs: `gcloud run services logs read safegate --region asia-south1`

## 5. Limits of this version, and how to scale it

- **One instance.** A scan's unpacked files live on the instance's `/tmp` for 20 minutes so fixes can be verified. With more instances a fix request may reach an instance that does not have the files. To scale out: turn on Cloud Run session affinity, or store the snapshot in Cloud Storage keyed by scan id.
- **`/tmp` uses memory** on Cloud Run. 1 GiB handles typical repos (80 MB archive limit). Raise `--memory` for larger ones.
- **Public repos only.** Private repos use the CLI or GitHub Action today; a GitHub App is the next step.
- **Abuse limits** are per IP and in memory: 12 scans and 40 fix requests per 10 minutes, 25 fixes per scan (`SAFEGATE_SCANS_PER_10MIN`, `SAFEGATE_FIXES_PER_10MIN`, `SAFEGATE_FIXES_PER_SCAN`). Set a budget alert on the project before sharing the URL widely.

## 6. Cost control

- Cloud Run scales to zero, so an idle demo costs nothing for compute.
- Gemini is billed per token. Each fix sends one source file plus the Prisma schema, and retries at most 3 times.
- Create a budget alert: Console → Billing → Budgets & alerts.

## 7. Run locally

```bash
npm install && npm run build
GEMINI_API_KEY=your-key node dist/src/cli.js serve      # http://localhost:8080
GEMINI_API_KEY=your-key node dist/src/cli.js fix --root examples/demo-app
```

## 8. Remove everything

```bash
gcloud run services delete safegate --region asia-south1
gcloud iam service-accounts delete safegate-run@YOUR_PROJECT_ID.iam.gserviceaccount.com
```
