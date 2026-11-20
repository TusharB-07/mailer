// The scheduler: runs on every cron tick (once a minute).
// - flips retriable failed rows back to pending
// - finds campaigns whose next_run_at is due
// - sends the next batch via Resend
// - updates counts + next_run_at (drip interval)
// - handles recurring rollover when a cycle completes
import type { Env, CampaignRow, OutboxRow } from "./types";
import { nowSec, nextOccurrence } from "./util";
import { sendBatch, buildAttachments, type EmailItem } from "./resend";
import { recomputeCounts, setCampaignStatus, insertOutboxRows, getCampaign } from "./db";

const MAX_RETRY = 3;
const RETRY_BACKOFF_SEC = 300; // 5 min

export async function runScheduler(env: Env): Promise<{ processed: number; sent: number; failed: number }> {
  const t = nowSec();
  const stats = { processed: 0, sent: 0, failed: 0 };

  // 1. Re-queue retriable failed rows.
  await env.DB.prepare(
    `UPDATE mailer_outbox
        SET status = 'pending', next_retry_at = NULL
      WHERE status = 'failed' AND retry_count < ? AND next_retry_at <= ?`
  )
    .bind(MAX_RETRY, t)
    .run();

  // 2. Find due campaigns.
  const due = await env.DB.prepare(
    `SELECT * FROM mailer_campaigns
      WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at ASC
      LIMIT 50`
  )
    .bind(t)
    .all<CampaignRow>();

  for (const c of (due.results || []) as CampaignRow[]) {
    stats.processed++;
    try {
      const r = await processCampaign(env, c);
      stats.sent += r.sent;
      stats.failed += r.failed;
    } catch (err) {
      // Never let one campaign's error kill the whole tick.
      console.error(`mailer: campaign ${c.id} errored`, err);
      await env.DB.prepare(
        "UPDATE mailer_campaigns SET next_run_at = ? WHERE id = ?"
      )
        .bind(t + Math.max(c.interval_minutes, 1) * 60, c.id)
        .run();
    }
  }

  return stats;
}

async function processCampaign(
  env: Env,
  c: CampaignRow
): Promise<{ sent: number; failed: number }> {
  const t = nowSec();

  // Pick the next pending batch. A row with a send_at in the future is
  // held back until its time; NULL send_at rows follow the campaign cadence.
  const pick = await env.DB.prepare(
    `SELECT * FROM mailer_outbox
      WHERE campaign_id = ? AND status = 'pending'
        AND (send_at IS NULL OR send_at <= ?)
      ORDER BY seq ASC LIMIT ?`
  )
    .bind(c.id, t, c.batch_size)
    .all<OutboxRow>();

  const rows = (pick.results || []) as OutboxRow[];

  // No eligible rows. If some are waiting on a future send_at, park the
  // campaign until the earliest one; otherwise the cycle may be complete.
  if (rows.length === 0) {
    const next = await env.DB.prepare(
      `SELECT MIN(send_at) AS at FROM mailer_outbox
        WHERE campaign_id = ? AND status = 'pending'
          AND send_at IS NOT NULL AND send_at > ?`
    )
      .bind(c.id, t)
      .first<{ at: number | null }>();
    if (next?.at) {
      await env.DB.prepare(
        "UPDATE mailer_campaigns SET next_run_at=?, updated_at=? WHERE id=?"
      )
        .bind(next.at, t, c.id)
        .run();
      return { sent: 0, failed: 0 };
    }
    await maybeCompleteOrRecur(env, c);
    return { sent: 0, failed: 0 };
  }

  // Mark them "sending" so a parallel tick can't double-send.
  const ids = rows.map((r) => r.id);
  await env.DB.prepare(
    `UPDATE mailer_outbox SET status = 'sending' WHERE id IN (${ids.map(() => "?").join(",")})`
  )
    .bind(...ids)
    .run();

  // Build email items (attachments shared across the campaign).
  const attachments = c.tracking_enabled
    ? await buildAttachments(env, c.id)
    : await buildAttachments(env, c.id); // attachments independent of tracking flag

  const items: EmailItem[] = rows.map((r) => ({
    from: c.sender_address,
    to: r.to_email,
    subject: r.subject_rendered,
    html: r.body_rendered,
    replyTo: c.reply_to || undefined,
    attachments: attachments.length ? attachments : undefined,
    tags: [
      { name: "campaign_id", value: c.id },
      { name: "outbox_id", value: r.id },
    ],
    headers: c.reply_to ? { "X-Mailer": "asterick-mailer" } : { "X-Mailer": "asterick-mailer" },
  }));

  const results = await sendBatch(env, items);
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const res = results[i] || { ok: false, error: "no result" };
    if (res.ok) {
      sent++;
      await env.DB.prepare(
        `UPDATE mailer_outbox SET status='sent', resend_id=?, sent_at=?, error=NULL WHERE id=?`
      )
        .bind(res.resendId || null, t, row.id)
        .run();
    } else {
      failed++;
      await env.DB.prepare(
        `UPDATE mailer_outbox
            SET status='failed',
                error=?,
                retry_count=retry_count+1,
                next_retry_at=?
          WHERE id=?`
      )
        .bind((res.error || "").slice(0, 500), t + RETRY_BACKOFF_SEC, row.id)
        .run();
    }
  }

  // Recompute counts + schedule the next drip.
  await recomputeCounts(env, c.id);
  const next = t + Math.max(c.interval_minutes, 1) * 60;
  await env.DB.prepare(
    "UPDATE mailer_campaigns SET next_run_at=?, updated_at=? WHERE id=?"
  )
    .bind(next, t, c.id)
    .run();

  // If nothing left pending after this batch, check completion / recurrence.
  const remaining = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM mailer_outbox WHERE campaign_id=? AND status='pending'"
  )
    .bind(c.id)
    .first<{ n: number }>();
  if ((remaining?.n || 0) === 0) {
    await maybeCompleteOrRecur(env, c);
  }

  return { sent, failed };
}

// When every row is sent/failed, either mark complete or roll over for recurring.
async function maybeCompleteOrRecur(env: Env, c: CampaignRow): Promise<void> {
  const t = nowSec();
  const pending = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM mailer_outbox WHERE campaign_id=? AND status IN ('pending','sending')"
  )
    .bind(c.id)
    .first<{ n: number }>();
  if ((pending?.n || 0) > 0) return; // still draining

  if (!c.recurring_freq) {
    await setCampaignStatus(env, c.id, "completed");
    return;
  }

  // Honor recurring_until.
  if (c.recurring_until && t >= c.recurring_until) {
    await setCampaignStatus(env, c.id, "completed");
    return;
  }

  // Rollover: clone all original rows back to pending with new ids, reset counts.
  const orig = await env.DB.prepare(
    "SELECT seq, to_email, subject_rendered, body_rendered, merge_data FROM mailer_outbox WHERE campaign_id=? ORDER BY seq ASC"
  )
    .bind(c.id)
    .all<Pick<OutboxRow, "seq" | "to_email" | "subject_rendered" | "body_rendered" | "merge_data">>();

  const rows = (orig.results || []) as OutboxRow[];
  await insertOutboxRows(
    env,
    c.id,
    rows.map((r) => ({
      seq: r.seq,
      toEmail: r.to_email,
      subjectRendered: r.subject_rendered,
      bodyRendered: r.body_rendered,
      mergeData: r.merge_data,
    }))
  );

  const next = nextOccurrence(c.recurring_freq, t);
  await env.DB.prepare(
    "UPDATE mailer_campaigns SET next_run_at=?, total_rows=?, sent_count=0, failed_count=0, updated_at=? WHERE id=?"
  )
    .bind(next, rows.length, t, c.id)
    .run();

  // Re-fetch to keep types honest (not strictly needed).
  await getCampaign(env, c.id);
}
