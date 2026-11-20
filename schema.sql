-- ==================================================================
-- Mailer schema
-- Added to the SAME D1 database Mailflare already uses.
-- All tables are prefixed with `mailer_` so they never collide with
-- Mailflare's own tables (mailboxes, domains, messages, ...).
--
-- Apply locally:    npx wrangler d1 execute mailflare --file=./schema.sql --local
-- Apply to prod:    npx wrangler d1 execute mailflare --file=./schema.sql --remote
-- (all CREATE statements are IF NOT EXISTS; see the SendAt migration at
--  the end of this file, which runs once per database.)
-- ==================================================================

CREATE TABLE IF NOT EXISTS mailer_campaigns (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  sender_address     TEXT NOT NULL,
  sender_mailbox_id  TEXT,
  reply_to           TEXT,
  subject_template   TEXT NOT NULL,
  body_template      TEXT NOT NULL,
  total_rows         INTEGER NOT NULL DEFAULT 0,
  sent_count         INTEGER NOT NULL DEFAULT 0,
  failed_count       INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'active',   -- active | paused | completed | draft
  schedule_mode      TEXT NOT NULL DEFAULT 'now',      -- now | datetime | interval
  scheduled_at       INTEGER,                           -- unix seconds: when the first batch fires
  interval_minutes   INTEGER NOT NULL DEFAULT 30,
  batch_size         INTEGER NOT NULL DEFAULT 5,
  next_run_at        INTEGER,                           -- unix seconds: next cron pickup
  tracking_enabled   INTEGER NOT NULL DEFAULT 1,
  recurring_freq     TEXT,                              -- null | daily | weekly | monthly
  recurring_until    INTEGER,                           -- unix seconds; null = forever
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mailer_campaigns_due_idx
  ON mailer_campaigns (status, next_run_at);

CREATE TABLE IF NOT EXISTS mailer_outbox (
  id               TEXT PRIMARY KEY,
  campaign_id      TEXT NOT NULL REFERENCES mailer_campaigns(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  to_email         TEXT NOT NULL,
  subject_rendered TEXT NOT NULL,
  body_rendered    TEXT NOT NULL,
  merge_data       TEXT,                                -- JSON blob of extra Excel columns
  status           TEXT NOT NULL DEFAULT 'pending',     -- pending | sending | sent | failed
  resend_id        TEXT,
  error            TEXT,
  retry_count      INTEGER NOT NULL DEFAULT 0,
  next_retry_at    INTEGER,
  sent_at          INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mailer_outbox_pick_idx
  ON mailer_outbox (campaign_id, status, seq);
CREATE INDEX IF NOT EXISTS mailer_outbox_retry_idx
  ON mailer_outbox (status, next_retry_at);

CREATE TABLE IF NOT EXISTS mailer_attachments (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES mailer_campaigns(id) ON DELETE CASCADE,
  r2_key      TEXT NOT NULL,
  filename    TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mailer_attachments_campaign_idx
  ON mailer_attachments (campaign_id);

CREATE TABLE IF NOT EXISTS mailer_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id  TEXT,
  outbox_id    TEXT,
  event_type   TEXT NOT NULL,   -- sent | delivered | opened | clicked | bounced | complained | failed
  resend_id    TEXT,
  payload      TEXT,            -- JSON
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mailer_events_campaign_idx
  ON mailer_events (campaign_id, created_at);

-- ------------------------------------------------------------------
-- Migration: per-row SendAt (2026-11-20)
-- Adds mailer_outbox.send_at (unix seconds) so each recipient row can
-- be scheduled independently of the campaign-level next_run_at.
--
-- SQLite/D1 has no `ADD COLUMN IF NOT EXISTS`, so this ALTER runs once
-- per database. On a fresh database it applies right after the CREATE
-- TABLE above; on an existing database it adds the missing column.
-- ------------------------------------------------------------------
ALTER TABLE mailer_outbox ADD COLUMN send_at INTEGER;
CREATE INDEX IF NOT EXISTS mailer_outbox_sendat_idx
  ON mailer_outbox (campaign_id, status, send_at);
