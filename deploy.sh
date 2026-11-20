#!/usr/bin/env bash
# Deploys Mailer to Cloudflare. Interactive where secrets are involved.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Installing dependencies"
npm install

echo
echo "==> wrangler.toml: paste your Mailflare D1 database_id"
echo "    (run: npx wrangler d1 list   to find the id for the 'mailflare' database)"
echo
read -r -p "Have you replaced REPLACE_WITH_YOUR_MAILFLARE_D1_ID in wrangler.toml? [y/N] " ok < /dev/tty
if [[ ! "$ok" =~ ^[Yy]$ ]]; then
  echo "Set it first, then re-run this script."
  exit 1
fi

echo "==> Creating R2 bucket 'mailer-attachments' (skip if it exists)"
npx wrangler r2 bucket create mailer-attachments 2>/dev/null || echo "    (already exists or unavailable locally — continuing)"

echo "==> Applying schema.sql to the shared D1 (remote)"
npm run db:migrate:remote

echo "==> Secrets — set each with an interactive prompt"
for s in RESEND_API_KEY AUTH_PASSWORD SESSION_SECRET; do
  read -r -p "Set $s now? [y/N] " yn < /dev/tty
  if [[ "$yn" =~ ^[Yy]$ ]]; then
    npx wrangler secret put "$s" < /dev/tty
  else
    echo "    (skipped — set it later with: npx wrangler secret put $s)"
  fi
done

echo "==> Deploying Worker"
npm run deploy

echo
echo "==> Done. Now point mailer.asterick.tech at it:"
echo "    Cloudflare dashboard → Workers & Pages → mailer →"
echo "    Settings → Domains & Routes → Add Custom Domain → mailer.asterick.tech"
echo
echo "    (asterick.tech is already on Cloudflare, so DNS + TLS are automatic.)"
