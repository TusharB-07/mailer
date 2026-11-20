// D1 query helpers for campaign + outbox + attachment operations.
import type { Env, CampaignRow, OutboxRow, AttachmentRow } from "./types";
import { newId, nowSec } from "./util";

export async function insertCampaign(
  env: Env,
  data: {
    id?: string;
    name: string;
    senderAddress: string;
    senderMailboxId: string | null;
    replyTo: string | null;
    subjectTemplate: string;
    bodyTemplate: string;
    totalRows: number;
    status: CampaignRow["status"];
    scheduleMode: CampaignRow["schedule_mode"];
    scheduledAt: number | null;
    intervalMinutes: number;
    batchSize: number;
    nextRunAt: number | null;
    trackingEnabled: boolean;
    recurringFreq: CampaignRow["recurring_freq"];
    recurringUntil: number | null;
  }
): Promise<string> {
  const id = data.id || newId();
  const ts = nowSec();
  await env.DB.prepare(
    `INSERT INTO mailer_campaigns
       (id, name, sender_address, sender_mailbox_id, reply_to,
        subject_template, body_template, total_rows, sent_count, failed_count,
        status, schedule_mode, scheduled_at, interval_minutes, batch_size,
        next_run_at, tracking_enabled, recurring_freq, recurring_until,
        created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      id,
      data.name,
      data.senderAddress,
      data.senderMailboxId,
      data.replyTo,
      data.subjectTemplate,
      data.bodyTemplate,
      data.totalRows,
      0,
      0,
      data.status,
      data.scheduleMode,
      data.scheduledAt,
      data.intervalMinutes,
      data.batchSize,
      data.nextRunAt,
      data.trackingEnabled ? 1 : 0,
      data.recurringFreq,
      data.recurringUntil,
      ts,
      ts
    )
    .run();
  return id;
}

// Bulk insert outbox rows using D1 batch (one statement per row, sent in one round-trip).
export async function insertOutboxRows(
  env: Env,
  campaignId: string,
  rows: Array<{
    seq: number;
    toEmail: string;
    subjectRendered: string;
    bodyRendered: string;
    mergeData: string | null;
  }>
): Promise<void> {
  if (rows.length === 0) return;
  const ts = nowSec();
  const stmts = rows.map((r) =>
    env.DB.prepare(
      `INSERT INTO mailer_outbox
         (id, campaign_id, seq, to_email, subject_rendered, body_rendered,
          merge_data, status, retry_count, created_at)
       VALUES (?,?,?,?,?,?,?,?,0,?)`
    ).bind(newId(), campaignId, r.seq, r.toEmail, r.subjectRendered, r.bodyRendered, r.mergeData, "pending", ts)
  );
  // D1 batch limit is ~1000 statements per call; chunk to be safe.
  const CHUNK = 500;
  for (let i = 0; i < stmts.length; i += CHUNK) {
    await env.DB.batch(stmts.slice(i, i + CHUNK));
  }
}

export async function getCampaign(env: Env, id: string): Promise<CampaignRow | null> {
  return await env.DB.prepare("SELECT * FROM mailer_campaigns WHERE id = ?")
    .bind(id)
    .first<CampaignRow>();
}

export async function listCampaigns(env: Env, limit = 100): Promise<CampaignRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM mailer_campaigns ORDER BY created_at DESC LIMIT ?"
  )
    .bind(limit)
    .all<CampaignRow>();
  return (res.results || []) as CampaignRow[];
}

export async function listOutboxForCampaign(
  env: Env,
  id: string,
  limit = 1000
): Promise<OutboxRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM mailer_outbox WHERE campaign_id = ? ORDER BY seq ASC LIMIT ?"
  )
    .bind(id, limit)
    .all<OutboxRow>();
  return (res.results || []) as OutboxRow[];
}

export async function listAttachmentsFor(
  env: Env,
  id: string
): Promise<AttachmentRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM mailer_attachments WHERE campaign_id = ? ORDER BY created_at ASC"
  )
    .bind(id)
    .all<AttachmentRow>();
  return (res.results || []) as AttachmentRow[];
}

export async function setCampaignStatus(
  env: Env,
  id: string,
  status: CampaignRow["status"]
): Promise<void> {
  await env.DB.prepare(
    "UPDATE mailer_campaigns SET status = ?, updated_at = ? WHERE id = ?"
  )
    .bind(status, nowSec(), id)
    .run();
}

export async function deleteCampaign(env: Env, id: string): Promise<void> {
  // ON DELETE CASCADE removes outbox + attachments rows.
  await env.DB.prepare("DELETE FROM mailer_campaigns WHERE id = ?")
    .bind(id)
    .run();
}

export async function recomputeCounts(env: Env, id: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE mailer_campaigns
        SET sent_count   = (SELECT COUNT(*) FROM mailer_outbox WHERE campaign_id=? AND status='sent'),
            failed_count = (SELECT COUNT(*) FROM mailer_outbox WHERE campaign_id=? AND status='failed'),
            updated_at   = ?
      WHERE id=?`
  )
    .bind(id, id, nowSec(), id)
    .run();
}

export async function insertAttachment(
  env: Env,
  data: { campaignId: string; r2Key: string; filename: string; mimeType: string; size: number }
): Promise<string> {
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO mailer_attachments (id, campaign_id, r2_key, filename, mime_type, size, created_at)
     VALUES (?,?,?,?,?,?,?)`
  )
    .bind(id, data.campaignId, data.r2Key, data.filename, data.mimeType, data.size, nowSec())
    .run();
  return id;
}

export async function recordEvent(
  env: Env,
  data: { campaignId?: string | null; outboxId?: string | null; eventType: string; resendId?: string | null; payload?: string }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO mailer_events (campaign_id, outbox_id, event_type, resend_id, payload, created_at)
     VALUES (?,?,?,?,?,?)`
  )
    .bind(data.campaignId ?? null, data.outboxId ?? null, data.eventType, data.resendId ?? null, data.payload ?? null, nowSec())
    .run();
}
