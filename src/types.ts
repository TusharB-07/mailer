// Cloudflare Worker bindings + secrets.
export interface Env {
  // bindings
  ASSETS: Fetcher;
  DB: D1Database;
  ATTACH: R2Bucket;

  // vars (from wrangler.toml [vars])
  APP_NAME: string;
  DEFAULT_FROM_DOMAIN: string;
  DEFAULT_BATCH_SIZE: string;
  DEFAULT_INTERVAL_MINUTES: string;
  RESEND_BATCH_MAX: string;
  RESEND_API_BASE: string;
  SESSION_TTL_HOURS: string;

  // secrets (set via `wrangler secret put ...`)
  RESEND_API_KEY: string;
  AUTH_PASSWORD: string;
  SESSION_SECRET: string;
}

// Typed row shapes (kept loose where D1 returns unknown).
export interface CampaignRow {
  id: string;
  name: string;
  sender_address: string;
  sender_mailbox_id: string | null;
  reply_to: string | null;
  subject_template: string;
  body_template: string;
  total_rows: number;
  sent_count: number;
  failed_count: number;
  status: "active" | "paused" | "completed" | "draft";
  schedule_mode: "now" | "datetime" | "interval";
  scheduled_at: number | null;
  interval_minutes: number;
  batch_size: number;
  next_run_at: number | null;
  tracking_enabled: number;
  recurring_freq: "daily" | "weekly" | "monthly" | null;
  recurring_until: number | null;
  created_at: number;
  updated_at: number;
}

export interface OutboxRow {
  id: string;
  campaign_id: string;
  seq: number;
  to_email: string;
  subject_rendered: string;
  body_rendered: string;
  merge_data: string | null;
  status: "pending" | "sending" | "sent" | "failed";
  resend_id: string | null;
  error: string | null;
  retry_count: number;
  next_retry_at: number | null;
  sent_at: number | null;
  send_at: number | null;
  created_at: number;
}

export interface AttachmentRow {
  id: string;
  campaign_id: string;
  r2_key: string;
  filename: string;
  mime_type: string;
  size: number;
  created_at: number;
}

export interface EventRow {
  id: number;
  campaign_id: string | null;
  outbox_id: string | null;
  event_type: string;
  resend_id: string | null;
  payload: string | null;
  created_at: number;
}
