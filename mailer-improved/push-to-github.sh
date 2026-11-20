#!/usr/bin/env bash
# Pushes the Mailer project to a NEW PRIVATE GitHub repository.
#
# SECURITY: the token is read from your environment variable GH_TOKEN.
# It is NEVER written to a file, never echoed, and never stored in git config.
#
# Usage (run from the mailer/ directory, or anywhere — it cd's itself):
#
#   # 1) Create a fresh fine-grained PAT at https://github.com/settings/personal-access-tokens/new
#   #    Repository access: "All repositories" (or your account).
#   #    Permissions: Administration (read/write), Contents (read/write).
#   #
#   # 2) Export it in your OWN terminal (do NOT paste it into any chat):
#   export GH_TOKEN=github_pat_xxxxxxxxxxxxx
#   #
#   # 3) Run this script:
#   ./push-to-github.sh                  # repo name defaults to "mailer"
#   ./push-to-github.sh my-mailer-repo   # or pass a custom name
#
set -euo pipefail
cd "$(dirname "$0")"

REPO_NAME="${1:-mailer}"

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "ERROR: GH_TOKEN is not set in your environment."
  echo
  echo "Create a fine-grained PAT with repo Administration + Contents permissions at:"
  echo "  https://github.com/settings/personal-access-tokens/new"
  echo "Then export it (do NOT paste it in chat):"
  echo "  export GH_TOKEN=github_pat_xxxxxx"
  exit 1
fi

# Fetch the authenticated user's login (token never printed).
USER=$(curl -sS -H "Authorization: Bearer ${GH_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/user | python3 -c "import json,sys; print(json.load(sys.stdin).get('login',''))" 2>/dev/null || true)

if [[ -z "$USER" ]]; then
  echo "ERROR: could not authenticate with GitHub. Check that GH_TOKEN is valid."
  exit 1
fi
echo "Authenticated as: $USER"

# Create the private repo (ignore error if it already exists).
echo "Creating private repo '$REPO_NAME' under $USER..."
HTTP=$(curl -sS -o /tmp/mailer_gh_resp.json -w "%{http_code}" \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  -X POST \
  -d "{\"name\":\"${REPO_NAME}\",\"private\":true,\"description\":\"Bulk + scheduled email sender — Cloudflare Worker + D1 + Resend (asterick.tech)\"}" \
  https://api.github.com/user/repos || true)

if [[ "$HTTP" == "201" ]]; then
  echo "  created."
elif [[ "$HTTP" == "422" ]]; then
  echo "  repo already exists — continuing (will push to it)."
else
  echo "  unexpected response ($HTTP):"
  cat /tmp/mailer_gh_resp.json
  exit 1
fi
rm -f /tmp/mailer_gh_resp.json

# Init git locally (don't push node_modules / .wrangler / secrets).
if [[ ! -d .git ]]; then
  git init -q
  git branch -M main 2>/dev/null || git checkout -b main
fi
git add -A
if ! git diff --cached --quiet; then
  git commit -q -m "Initial commit: Mailer (Cloudflare Worker + D1 + Resend)" || true
fi

# Set the remote (NO token in the URL).
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/${USER}/${REPO_NAME}.git"

# Push using the token as an Authorization header — it is NOT persisted
# to .git/config and NOT echoed to the terminal.
echo "Pushing to github.com/${USER}/${REPO_NAME} (private)..."
git -c "http.extraheader=Authorization: Bearer ${GH_TOKEN}" push -u origin main

echo
echo "Done: https://github.com/${USER}/${REPO_NAME}"
echo
echo "Reminder: if this token was ever pasted in a chat or terminal history,"
echo "revoke it now at https://github.com/settings/personal-access-tokens"
