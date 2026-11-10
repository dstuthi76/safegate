#!/usr/bin/env bash
# Deploys the safegate web service to Cloud Run, using Gemini on Vertex AI (no API key to manage)
# and Firestore for usage counters.
#
# Usage:   PROJECT_ID=my-project ./deploy/deploy.sh
# Options: REGION (default asia-south1, Mumbai), SERVICE (default safegate),
#          MODEL (default gemini-3.8-flash,gemini-3.6-flash), GITHUB_TOKEN (optional, raises GitHub's download limit)
#
# Needs: gcloud CLI, logged in (gcloud auth login), billing enabled on the project.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID to your Google Cloud project id}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-safegate}"
MODEL="${MODEL:-gemini-3.8-flash,gemini-3.6-flash}"
SA_NAME="safegate-run"
SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

cd "$(dirname "$0")/.."

echo "1/5 Enabling APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  aiplatform.googleapis.com firestore.googleapis.com --project "$PROJECT_ID"

echo "2/5 Creating the service account (least privilege: call Gemini, read/write Firestore)"
gcloud iam service-accounts describe "$SA" --project "$PROJECT_ID" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$SA_NAME" --display-name "safegate Cloud Run" --project "$PROJECT_ID"
for ROLE in roles/aiplatform.user roles/datastore.user; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:${SA}" --role "$ROLE" --condition=None --quiet >/dev/null
done

echo "3/5 Creating the Firestore database (skipped if it exists)"
gcloud firestore databases describe --database="(default)" --project "$PROJECT_ID" >/dev/null 2>&1 ||
  gcloud firestore databases create --database="(default)" --location="$REGION" --project "$PROJECT_ID"

echo "4/5 Building and deploying to Cloud Run"
# gcloud splits --set-env-vars on commas, so the model list uses a custom delimiter.
gcloud run deploy "$SERVICE" --source . --project "$PROJECT_ID" --region "$REGION" \
  --service-account "$SA" --allow-unauthenticated \
  --memory 1Gi --cpu 1 --concurrency 20 --timeout 300 \
  --min-instances 0 --max-instances 1 \
  --set-env-vars "^@^GOOGLE_CLOUD_PROJECT=${PROJECT_ID}@GOOGLE_CLOUD_LOCATION=global@GOOGLE_GENAI_USE_VERTEXAI=true@SAFEGATE_FIRESTORE=1@SAFEGATE_GEMINI_MODEL=${MODEL}${GITHUB_TOKEN:+@GITHUB_TOKEN=${GITHUB_TOKEN}}"

echo "5/5 Checking the live service"
URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format 'value(status.url)')"
curl -fsS "${URL}/healthz" && echo
curl -fsS "${URL}/api/config" && echo
echo "Live at: ${URL}"
echo "Note: --max-instances 1 keeps each scan and its fix requests on the same instance. See docs/DEPLOY.md before raising it."
