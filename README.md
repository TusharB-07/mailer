# Mailer — asterick.tech

A self-hosted bulk + scheduled email sender that lives at **`mailer.asterick.tech`** next to your Mailflare install. Upload an Excel sheet, pick a sender from your Mailflare mailboxes, choose **send now / pick a date & time / drip on an interval**, and the cron does the rest — sending through **Resend**.

Runs entirely on **Cloudflare Workers + D1 + R2 + Cron Triggers**. No server, no monthly cost beyond your existing Resend plan.

---

## What it does

- **Excel in, emails out** — drag-and-drop `.xlsx` / `.csv`. Columns: `Email`, `Subject`, `Body`. Any extra column (e.g. `Name`, `Company`) becomes a merge tag (`{{Name}}`, `{{Company}}`).
- **Sender dropdown pulled live from Mailflare** — reads the `mailboxes` + `domains` tables in your shared D1, so it's always current.
- **Three schedule modes**
  - **Send now** — fires the first batch immediately, then drips the rest on the interval.
  - **Pick date & time** — first batch at the chosen moment, then drips.
  - **Interval drip** — steady cadence from creation.
- **Per-campaign interval + batch size** — stored in D1, no redeploy to change.
- **Merge tags** — `{{anything}}` substituted in subject + body per recipient.
- **Attachments** — up to 10 files / 10 MB each, stored in R2, attached to every email.
- **Open & click tracking** — via Resend; delivery events captured through the webhook into a `mailer_events` table.
- **Pause / resume / retry** — failed rows auto-retry up to 3×; pause mid-campaign and resume.
- **CSV export** — full sent / failed / pending report per campaign.
- **Preview + test send** — live-render the merged email and send a one-off test to yourself.
- **Recurring campaigns** — re-run daily / weekly / monthly until a chosen end date.
- **Password auth** — single admin password as a Worker secret; HMAC-signed session cookie.
- **Theme matched to asterick.tech** — Geist font, neutral shadcn palette, primary blue `#1447e6`, brand green `#244c41`. Light + dark.

---

## Architecture

```
mailer.asterick.tech  (Cloudflare Worker)
        │
        ├── static assets (./public)   → dashboard UI (HTML/CSS/JS)
        ├── /api/*  (Hono router)      → auth, senders, campaigns, attachments, webhook
        ├── D1 binding "DB"            → shared with Mailflare (reads mailboxes, writes mailer_* tables)
        ├── R2 binding "ATTACH"        → attachment storage (bucket: mailer-attachments)
        ├── Cron Trigger  * * * * *    → scheduler: due campaigns → Resend batch → mark sent/failed
        └── Resend API                 → sends the mail (RESEND_API_KEY secret)
```

**Excel is parsed in the browser** with SheetJS — only JSON rows hit the Worker. This sidesteps the Workers free-tier CPU limit and keeps the upload fast.

All tables are prefixed `mailer_` so they never collide with Mailflare's own tables (`mailboxes`, `domains`, `messages`, …) in the same D1.

---

## Deploy to Cloudflare

You need: Node 20+, the `wrangler` CLI (installed via `npm install`), and your Cloudflare account logged in.

### 1. Install + log in

```bash
cd mailer
npm install
npx wrangler login          # opens browser, authorize Cloudflare
```

### 2. Find your Mailflare D1 database id

```bash
npx wrangler d1 list
```

Look for the database named `mailflare` (the one Mailflare already uses). Copy its `database_id` and paste it into **`wrangler.toml`**:

```toml
[[d1_databases]]
binding = "DB"
database_name = "mailflare"
database_id = "PASTE_THE_ID_HERE"
```

### 3. Create the R2 bucket for attachments

```bash
npx wrangler r2 bucket create mailer-attachments
```

### 4. Apply the schema to the shared D1

This adds the `mailer_*` tables to Mailflare's database. Safe to re-run.

```bash
# local (for dev)
npm run db:migrate:local

# production
npm run db:migrate:remote
```

### 5. Set your secrets

```bash
npx wrangler secret put RESEND_API_KEY      # your Resend API key (re_xxx...)
npx wrangler secret put AUTH_PASSWORD       # a long, random admin password
npx wrangler secret put SESSION_SECRET      # any random 32+ char string
```

For local dev, copy `.dev.vars.example` to `.dev.vars` and fill in the same three values.

### 6. Deploy

```bash
npm run deploy
```

You'll get a URL like `https://mailer.<your-subdomain>.workers.dev`. Open it, sign in with `AUTH_PASSWORD`, and you're live.

### 7. Point `mailer.asterick.tech` at it

Two equivalent options:

**A. Custom domain in the Worker (recommended)** — in the Cloudflare dashboard → Workers & Pages → your `mailer` worker → **Settings → Domains & Routes → Add Custom Domain** → enter `mailer.asterick.tech`. Cloudflare auto-creates the DNS record (your `asterick.tech` zone is already on Cloudflare) and provisions TLS.

**B. Route in `wrangler.toml`** — add at the end:

```toml
[[routes]]
pattern = "mailer.asterick.tech"
custom_domain = true
```

…then `npm run deploy` again.

### 8. (Optional) Wire up Resend event tracking

In the Resend dashboard → **Webhooks → Add webhook** → URL:

```
https://mailer.asterick.tech/api/webhooks/resend?key=<SESSION_SECRET>
```

…select the events you want (delivered, opened, clicked, bounced, complained). They'll be recorded in `mailer_events` and bounces reflected on the outbox rows.

---

## Running locally

```bash
npm run db:migrate:local     # creates the mailer_* tables in local D1
npm run dev                  # wrangler dev — serves on http://localhost:8787
```

Local D1 won't have your real Mailflare mailboxes, so the sender dropdown will be empty in dev. To test the full flow, deploy to production.

---

## Server-side validation (everything is checked on the Worker)

The browser validates for UX only. **Every API input is re-validated server-side with zod**, and business rules are enforced in the Worker:

| Input | Server-side check |
|---|---|
| Login password | constant-time compare against `AUTH_PASSWORD` secret |
| Session cookie | HMAC-SHA256 verified, expiry checked |
| Sender address | must exist as a mailbox in Mailflare's `mailboxes` table (live D1 lookup) — the client dropdown value is never trusted |
| Each recipient row | email regex + length; subject/body length limits; `Subject`/`Body`/`SendAt` reserved keys stripped from merge data |
| Row count | 1–10,000 per campaign |
| Schedule mode | `now` / `datetime` / `interval`; `scheduledAt` required + must be a valid ISO datetime + not in the past when mode = `datetime` |
| Interval | integer 1–1440 min |
| Batch size | integer 1–100 |
| Recurring | `freq` ∈ daily/weekly/monthly; `until` must be valid ISO datetime if present |
| Attachments | max 10 MB per file, max 10 per campaign; stored in R2, re-linked to the campaign after creation |
| Merge tags | substituted server-side per row before send; unknown tags render empty (never crash) |
| Webhook | shared-secret (`?key=<SESSION_SECRET>`) gate, no session required |
| Cron | each campaign wrapped in try/catch so one failure can't kill the whole tick; failed rows auto-retry ≤ 3× with backoff |

Schemas live in [`src/validate.ts`](src/validate.ts). The sender verification is in [`src/senders.ts`](src/senders.ts).

---

## Resend limits to design around

| Plan | Daily cap | Rate | Fits |
|---|---|---|---|
| Free | **100 / day** (3,000 / month) | 10 req/s | ≤ 100 emails/day — use batch 5, interval 30 min |
| Pro ($20/mo) | none | 10 req/s | up to ~50,000/month |
| Scale ($90/mo) | none | 10 req/s | high volume + dedicated IP option |

The defaults in `wrangler.toml` (`DEFAULT_BATCH_SIZE=5`, `DEFAULT_INTERVAL_MINUTES=30`) keep you under the free-tier daily cap. Bump them in the new-campaign form as needed.

---

## Theming

The theme lives in [`public/app.css`](public/app.css) as CSS variables (`--bg`, `--fg`, `--primary`, `--brand`, `--accent`, `--radius`, …). It's tuned to match **asterick.tech** (Geist font, neutral grays, blue primary, green brand accent).

To swap in your own theme:
- Edit the variables under `:root` / `[data-theme="dark"]` in `public/app.css`, **or**
- Drop your own stylesheet at `public/app.css` and redeploy.

The Geist webfont loads from the jsDelivr CDN. To bundle it locally (no runtime CDN dependency), download `Geist-Variable.woff2` into `public/fonts/` and change the `@font-face` `src` to `/fonts/Geist-Variable.woff2`.

---

## File map

```
mailer/
├── wrangler.toml          Worker config: D1 (shared), R2, cron, vars, secrets
├── package.json           hono, zod, wrangler, workers-types
├── schema.sql             mailer_* tables (run on the shared Mailflare D1)
├── tsconfig.json
├── .dev.vars.example      local secrets template
├── deploy.sh              one-shot deploy helper
├── push-to-github.sh      creates a PRIVATE repo + pushes (token via env, never hardcoded)
├── src/
│   ├── index.ts           Hono routes + cron handler
│   ├── auth.ts            password auth, HMAC-signed session cookie
│   ├── db.ts              D1 query helpers
│   ├── senders.ts         reads Mailflare mailboxes + verifies sender
│   ├── resend.ts          Resend batch/single send, R2 attachments
│   ├── validate.ts        zod schemas (server-side validation)
│   ├── merge.ts           {{merge tag}} engine
│   ├── scheduler.ts       cron logic: due campaigns, batches, retry, recurring
│   ├── util.ts            ids, time, csv, email check
│   └── types.ts           Env bindings + row types
└── public/
    ├── index.html         dashboard (login, campaigns, new campaign, detail)
    ├── app.css            asterick.tech theme (CSS variables, light + dark)
    └── app.js             SheetJS parse, all UI interactions
```

---

## Security notes

- **Never commit secrets.** `.dev.vars` and `.env` are gitignored. Production secrets live in Cloudflare via `wrangler secret put`, never in the repo.
- The Resend webhook is gated by a shared secret in the query string (`SESSION_SECRET`). Rotate it if needed.
- The session cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, HMAC-signed, server-verified on every `/api/*` call.
- `mailer_`-prefixed tables are write-isolated from Mailflare's own schema — this app only **reads** `mailboxes` / `domains`, never writes to them.
- If you ever paste a secret into a chat or terminal history, **revoke and regenerate it immediately**. (This applies to the GitHub PAT and to Resend/Cloudflare keys alike.)

---

## License

MIT — do what you want.
