#!/usr/bin/env bash
# One-command, idempotent deploy of Google MCP Hub to Cloud Run.
#
#   cp deploy.env.example deploy.env   # fill in PROJECT_ID, REGION, OWNER_EMAILS
#   ./scripts/deploy.sh                # first run prints OAuth client instructions
#   ./scripts/deploy.sh                # second run deploys
#
# Flags:
#   --yes                  skip the confirmation prompt
#   --rotate-signing-key   sign everyone out of the hub (all Claude connections must re-authorise)
set -euo pipefail
cd "$(dirname "$0")/.."

YES=false
ROTATE=false
for arg in "$@"; do
  case "$arg" in
    --yes) YES=true ;;
    --rotate-signing-key) ROTATE=true ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

[[ -f deploy.env ]] || { echo "Missing deploy.env. Run: cp deploy.env.example deploy.env" >&2; exit 1; }
set -a; source deploy.env; set +a
: "${PROJECT_ID:?Set PROJECT_ID in deploy.env}" "${REGION:?Set REGION in deploy.env}" "${OWNER_EMAILS:?Set OWNER_EMAILS in deploy.env}"
SERVICE="${SERVICE:-google-mcp-hub}"
SA_NAME="hub-runtime"
SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
SECRETS=(hub-signing-key hub-google-client-secret hub-accounts)
G=(--project "$PROJECT_ID" --quiet)

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

step "Checking gcloud identity"
echo "Account: $(gcloud config get-value account 2>/dev/null)"
echo "Project: $PROJECT_ID   Region: $REGION   Service: $SERVICE"
echo "Owners:  $OWNER_EMAILS"
if [[ "$YES" != true ]]; then
  read -r -p "Deploy with these settings? [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || exit 1
fi

step "Enabling APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com gmail.googleapis.com drive.googleapis.com sheets.googleapis.com \
  docs.googleapis.com calendar-json.googleapis.com "${G[@]}"

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
URL="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"
CALLBACK="${URL}/oauth/google/callback"

if [[ -z "${GOOGLE_CLIENT_ID:-}" || -z "${GOOGLE_CLIENT_SECRET:-}" ]]; then
  cat <<EOF

One manual step: Google has no API for creating OAuth clients.

  1. Open https://console.cloud.google.com/auth/overview?project=${PROJECT_ID}
     and configure the consent screen (User type: External, or Internal for a Workspace-only hub).
  2. Under Audience, click "Publish app" so status is "In production".
     In "Testing" status Google expires every connected account after 7 days.
  3. Open https://console.cloud.google.com/auth/clients/create?project=${PROJECT_ID}
     Application type: Web application. Authorised redirect URIs:
       ${CALLBACK}
       http://localhost:8080/oauth/google/callback   (optional, for local development)
  4. Put the client ID and secret in deploy.env and run this script again.
EOF
  exit 0
fi

step "Service accounts"
ensure_sa() {
  gcloud iam service-accounts describe "$1@${PROJECT_ID}.iam.gserviceaccount.com" "${G[@]}" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "$1" --display-name "$2" "${G[@]}"
}
ensure_sa "$SA_NAME" "Google MCP Hub runtime"
# Builds run as their own account, so the project's default compute account needs no extra roles.
ensure_sa hub-builder "Google MCP Hub builder"
BUILD_SA="hub-builder@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$BUILD_SA" \
  --role roles/run.builder --condition None "${G[@]}" >/dev/null
echo "  $BUILD_SA -> roles/run.builder (source builds only)"

step "Secrets"
ensure_secret() {
  gcloud secrets describe "$1" "${G[@]}" >/dev/null 2>&1 ||
    gcloud secrets create "$1" --replication-policy automatic --labels app=google-mcp-hub "${G[@]}" >/dev/null
}
current() { gcloud secrets versions access latest --secret "$1" "${G[@]}" 2>/dev/null || true; }
put() { printf '%s' "$2" | gcloud secrets versions add "$1" --data-file - "${G[@]}" >/dev/null; echo "  $1: new version"; }

for s in "${SECRETS[@]}"; do ensure_secret "$s"; done
if [[ -z "$(current hub-signing-key)" || "$ROTATE" == true ]]; then
  put hub-signing-key "$(head -c 48 /dev/urandom | base64 | tr -d '\n')"
fi
[[ "$(current hub-google-client-secret)" == "$GOOGLE_CLIENT_SECRET" ]] || put hub-google-client-secret "$GOOGLE_CLIENT_SECRET"
[[ -n "$(current hub-accounts)" ]] || put hub-accounts '{}'

step "IAM (each role is granted on a single secret, nothing project-wide)"
bind() {
  gcloud secrets add-iam-policy-binding "$1" --member "serviceAccount:$SA" --role "$2" "${G[@]}" >/dev/null
  echo "  $SA -> $2 on $1"
}
for s in "${SECRETS[@]}"; do bind "$s" roles/secretmanager.secretAccessor; done
bind hub-accounts roles/secretmanager.secretVersionManager

step "Building and deploying to Cloud Run"
# Env vars go through a file: emails and commas break gcloud's inline dict syntax.
ENV_FILE="$(mktemp)"
trap 'rm -f "$ENV_FILE"' EXIT
cat > "$ENV_FILE" <<EOF
BASE_URL: "${URL}"
OWNER_EMAILS: "${OWNER_EMAILS}"
GOOGLE_CLIENT_ID: "${GOOGLE_CLIENT_ID}"
STORE: "gcp"
GCP_PROJECT: "${PROJECT_ID}"
ACCOUNTS_SECRET: "hub-accounts"
EOF
# Public ingress is required for Claude to reach the hub; the hub itself rejects anyone
# who has not signed in with an owner Google account and approved the connection.
gcloud run deploy "$SERVICE" --source . --region "$REGION" "${G[@]}" \
  --service-account "$SA" \
  --build-service-account "projects/${PROJECT_ID}/serviceAccounts/${BUILD_SA}" \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 1 --memory 256Mi --cpu 1 \
  --env-vars-file "$ENV_FILE" \
  --set-secrets "HUB_SIGNING_KEY=hub-signing-key:latest,GOOGLE_CLIENT_SECRET=hub-google-client-secret:latest"

cat <<EOF

Done.

  Hub:              ${URL}/
  Claude connector: ${URL}/mcp
  OAuth redirect:   ${CALLBACK}

Created or updated in ${PROJECT_ID}:
  Cloud Run service ${SERVICE} (${REGION}, scale to zero, max 1 instance)
  Service accounts  ${SA} (runtime: per-secret roles only)
                    ${BUILD_SA} (builds: roles/run.builder)
  Secrets           ${SECRETS[*]}

Next:
  1. Open ${URL}/ and connect each Google account with a label (personal, work, ...).
  2. In Claude: Settings > Connectors > Add custom connector > ${URL}/mcp
     Sign in with ${OWNER_EMAILS%%,*} and press Approve.
EOF
