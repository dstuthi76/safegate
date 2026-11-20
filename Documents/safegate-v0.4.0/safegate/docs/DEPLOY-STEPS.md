# Deploying safegate to Google Cloud, step by step

About 30 minutes. Everything after step 1 happens in your browser, in Google Cloud Shell, so there is nothing to install.

## Step 1: Put the latest code on GitHub (PowerShell, on your laptop)

```powershell
cd C:\Users\dell\Documents\safegate-v0.2\safegate
git status
git add -A
git commit -m "safegate v0.2.2"
git push
```

If git says "nothing to commit", GitHub is already up to date. Open https://github.com/dstuthi76/safegate and check that `Dockerfile` and `deploy/deploy.sh` are there. Keep the repository public, or the clone in step 5 will ask you to sign in to GitHub.

## Step 2: Create a Google Cloud project

1. Go to https://console.cloud.google.com/projectcreate
2. Enter a project name, for example `safegate`, and click **Create**.
3. Note the **Project ID** shown under the name (for example `safegate-472013`). You need the ID, not the name.

If your college account can't create projects, or later blocks public websites, use a personal Google account instead. College accounts often have organisation rules that block both.

## Step 3: Turn on billing

1. Go to https://console.cloud.google.com/billing
2. Link a billing account to the project. Use the free trial or your hackathon credits. Cloud Run and Cloud Build don't work without billing.

## Step 4: Open Cloud Shell and choose the project

Click the `>_` icon at the top right of the Cloud Console. In the terminal that opens, run (with your Project ID):

```bash
gcloud config set project YOUR_PROJECT_ID
export PROJECT_ID=$(gcloud config get-value project)
echo $PROJECT_ID
```

The last line should print your Project ID. If a box asks you to authorize Cloud Shell, click **Authorize**.

## Step 5: Get the code

```bash
cd ~
git clone https://github.com/dstuthi76/safegate.git
cd safegate
ls Dockerfile deploy/deploy.sh
```

The last command should list both files. If you cloned it before, run `cd ~/safegate && git pull` instead.

## Step 6: Deploy

```bash
bash deploy/deploy.sh
```

This takes 5 to 10 minutes and runs in five stages:

| Stage | What it does |
|---|---|
| 1/5 | Turns on Cloud Run, Cloud Build, Artifact Registry, Vertex AI and Firestore |
| 2/5 | Creates a service account, `safegate-run`, that can only call Gemini and write to Firestore |
| 3/5 | Creates the Firestore database in Mumbai (skipped if one exists) |
| 4/5 | Builds the container with Cloud Build and deploys it to Cloud Run |
| 5/5 | Calls the live site to check it answers |

If it asks whether to create an Artifact Registry repository, type `Y` and press Enter.

When it finishes, the last lines should look like this:

```
{"ok":true}
{"version":"0.2.0","ai":true,"model":"gemini-3.8-flash","aiMode":"vertex"}
Live at: https://safegate-....run.app
```

`"aiMode":"vertex"` means Gemini runs through Vertex AI with the service's own identity. No API key is needed on Google Cloud.

## Step 7: Check the live site

1. Open the `Live at` address and click **Try the demo app**. Expect 17 findings.
2. On the `AUTH003` card, click **Fix with Gemini**. Within about 40 seconds you should see a green **Verified fix**.
3. Paste `https://github.com/mfts/papermark` and click **Scan**.
4. Open `<your address>/api/stats`. The counters should be above zero. In https://console.cloud.google.com/firestore you should see the document `stats/global`.

## Step 8: Set a budget alert

Before you share the address: go to **Billing → Budgets & alerts → Create budget**, set an amount such as ₹500, and keep the email alerts at 50%, 90% and 100%. Cloud Run scales to zero, so an idle site costs almost nothing, but each Gemini fix uses tokens.

## Updating after a code change

On your laptop:

```powershell
git add -A
git commit -m "describe the change"
git push
```

In Cloud Shell (in a new Cloud Shell session, run the `export PROJECT_ID` line from step 4 first):

```bash
cd ~/safegate && git pull && bash deploy/deploy.sh
```

## If something fails

| What you see | What to do |
|---|---|
| "Billing must be enabled" or "billing account not found" | Do step 3, then run the script again |
| Stage 4/5 fails with `PERMISSION_DENIED`, `storage.objects.get` or "does not have permission" during the build | Give Cloud Build permission to build, then run the script again: `PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')` and then `gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" --role="roles/run.builder"` |
| The site shows `403 Forbidden`, or stage 4/5 warns it could not allow unauthenticated access | An organisation rule blocks public sites. Use a project under a personal Google account |
| `"ai":false` in the last lines | The settings did not apply. Run the script again |
| Fix says `Model ... was not found` | Run `MODEL=gemini-3.6-flash bash deploy/deploy.sh` |
| Fix says permission denied right after the first deploy | Wait two minutes for permissions to take effect, then try again |
| "GitHub rate limit reached" when scanning | Wait a few minutes, or redeploy with a GitHub token: `GITHUB_TOKEN=your-token bash deploy/deploy.sh` |
| "This scan has expired" right after a scan | Keep the instance limit at 1, as the script sets it |
| `PROJECT_ID: Set PROJECT_ID...` error | Run the `export PROJECT_ID` line from step 4 again |

To read the service's logs:

```bash
gcloud run services logs read safegate --region asia-south1 --limit 50
```

## Turning it off after the event

```bash
gcloud run services delete safegate --region asia-south1
```
