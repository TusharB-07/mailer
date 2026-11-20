// Mailer — Cloudflare Worker entry point.
// Serves the dashboard UI from static assets and exposes a JSON API.
// All API input is validated server-side (zod). The cron ticks once a minute.
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { getCookie } from "hono/cookie";
import type { Env, CampaignRow, OutboxRow } from "./types";
import {
  CampaignCreateSchema,
  LoginSchema,
  TestSendSchema,
  type CampaignCreateInput,
} from "./validate";
import {
  issueSession,
  clearSession,
  requireAuth,
  verifySession,
  checkPassword,
} from "./auth";
import { listSenders, verifySender } from "./senders";
import {
  insertCampaign,
  insertOutboxRows,
  insertAttachment,
  getCampaign,
  listCampaigns,
  listOutboxForCampaign,
  listAttachmentsFor,
  setCampaignStatus,
  deleteCampaign,
  recomputeCounts,
  recordEvent,
} from "./db";
import { renderMerge, buildMergeData, extractTags } from "./merge";
import { sendBatch, sendOne, buildAttachments } from "./resend";
import { runScheduler } from "./scheduler";
import { nowSec, newId, isEmail, rowsToCsv, clean } from "./util";

const app = new Hono<{ Bindings: Env }>();

// ------------------------------------------------------------------
// Auth
// ------------------------------------------------------------------
app.post("/api/login", zValidator("json", LoginSchema), async (c) => {
  const { password } = c.req.valid("json");
  const ok = await checkPassword(c.env, password);
  if (!ok) return c.json({ error: "invalid password" }, 401);
  await issueSession(c, c.env);
  return c.json({ ok: true });
});

app.post("/api/logout", (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

app.get("/api/session", async (c) => {
  const ok = await verifySession(c, c.env);
  return c.json({ authenticated: ok });
});

// Everything below (except the Resend webhook) requires auth.
const authed = new Hono<{ Bindings: Env }>();
authed.use("*", requireAuth);

// ------------------------------------------------------------------
// Senders (Mailflare mailboxes, live from shared D1)
// ------------------------------------------------------------------
authed.get("/api/senders", async (c) => {
  const senders = await listSenders(c.env);
  return c.json({ senders });
});

// ------------------------------------------------------------------
// Attachments: upload to R2, return an id the campaign create call references.
// ------------------------------------------------------------------
authed.post("/api/attachments", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "no file" }, 400);
  if (file.size > 10 * 1024 * 1024) return c.json({ error: "max 10 MB per file" }, 400);

  const id = newId();
  const key = `attachments/${id}/${file.name}`;
  await c.env.ATTACH.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });

  // Attach to a temp campaign id of "pending"; re-link at campaign create.
  const attId = await insertAttachment(c.env, {
    campaignId: "pending",
    r2Key: key,
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
  });
  return c.json({ id: attId, key, filename: file.name, size: file.size });
});

// ------------------------------------------------------------------
// Campaign create — the main flow.
// Excel is parsed IN THE BROWSER; the client posts JSON rows + config here.
// Server validates everything, verifies the sender against Mailflare,
// renders merge tags per row, inserts campaign + outbox, and (for
// scheduleMode='now') fires the first batch inline.
// ------------------------------------------------------------------
authed.post("/api/campaigns", zValidator("json", CampaignCreateSchema), async (c) => {
  const input = c.req.valid("json") as CampaignCreateInput;
  const env = c.env;
  const t = nowSec();

  // 1. Verify sender exists in Mailflare (server-side, not trusting client).
  const sender = await verifySender(env, input.senderAddress);
  if (!sender.ok) {
    return c.json({ error: "sender address not found in your Mailflare mailboxes" }, 400);
  }

  // 2. Determine schedule times.
  const mode = input.scheduleMode;
  const scheduledAt =
    mode === "datetime" && input.scheduledAt ? Math.floor(Date.parse(input.scheduledAt) / 1000) : t;
  if (mode === "datetime" && (!input.scheduledAt || Number.isNaN(scheduledAt))) {
    return c.json({ error: "invalid scheduledAt" }, 400);
  }
  if (mode === "datetime" && scheduledAt < t - 60) {
    return c.json({ error: "scheduledAt is in the past" }, 400);
  }
  // First pickup time = scheduledAt (or now), unless pure interval from now.
  const nextRunAt = scheduledAt;

  // 3. Render every row: merge tags applied to subject + body templates.
  //    A row may override subject/body with its own values.
  const rendered: Array<{
    seq: number;
    toEmail: string;
    subjectRendered: string;
    bodyRendered: string;
    mergeData: string | null;
    sendAt: number | null;
  }> = [];

  let seq = 0;
  for (const row of input.rows) {
    seq++;
    const email = clean(row.email).toLowerCase();
    if (!isEmail(email)) {
      return c.json({ error: `row ${seq}: invalid email "${row.email ?? ""}"` }, 400);
    }
    // Per-row SendAt: ISO string -> unix seconds. Absent => campaign timing.
    let sendAt: number | null = null;
    if (row.sendAt) {
      const parsed = Math.floor(Date.parse(row.sendAt) / 1000);
      if (Number.isNaN(parsed)) {
        return c.json({ error: `row ${seq}: invalid SendAt "${row.sendAt}"` }, 400);
      }
      sendAt = parsed;
    }
    const merge = buildMergeData(row as unknown as Record<string, string>, [
      "email",
      "subject",
      "body",
      "sendAt",
    ]);
    const subjectTpl = row.subject || input.subjectTemplate;
    const bodyTpl = row.body || input.bodyTemplate;
    const subjectRendered = renderMerge(subjectTpl, merge);
    const bodyRendered = renderMerge(bodyTpl, merge);
    if (!subjectRendered.trim()) {
      return c.json({ error: `row ${seq}: rendered subject is empty` }, 400);
    }
    rendered.push({
      seq,
      toEmail: email,
      subjectRendered,
      bodyRendered,
      mergeData: Object.keys(merge).length ? JSON.stringify(merge) : null,
      sendAt,
    });
  }

  // 4. Insert campaign + outbox.
  const recurringUntil = input.recurring?.until
    ? Math.floor(Date.parse(input.recurring.until) / 1000)
    : null;

  const campaignId = await insertCampaign(env, {
    name: input.name,
    senderAddress: input.senderAddress,
    senderMailboxId: sender.mailboxId,
    replyTo: input.replyTo || null,
    subjectTemplate: input.subjectTemplate,
    bodyTemplate: input.bodyTemplate,
    totalRows: rendered.length,
    status: "active",
    scheduleMode: mode,
    scheduledAt: mode === "datetime" ? scheduledAt : null,
    intervalMinutes: input.intervalMinutes,
    batchSize: input.batchSize,
    nextRunAt,
    trackingEnabled: input.trackingEnabled,
    recurringFreq: input.recurring?.freq || null,
    recurringUntil,
  });

  await insertOutboxRows(env, campaignId, rendered);

  // 5. Re-link uploaded attachments from "pending" campaign to the real id.
  if (input.attachmentIds.length) {
    for (const aid of input.attachmentIds) {
      await env.DB.prepare(
        "UPDATE mailer_attachments SET campaign_id=? WHERE id=? AND campaign_id='pending'"
      )
        .bind(campaignId, aid)
        .run();
    }
  }

  // 6. For "send now": fire the first batch inline so the user sees instant action.
  let sentNow = 0;
  if (mode === "now") {
    sentNow = await fireFirstBatchInline(env, await getCampaign(env, campaignId));
  }

  const fresh = await getCampaign(env, campaignId);
  return c.json({ ok: true, campaign: fresh, sentNow });
});

// Send the first batch immediately (only used by scheduleMode='now').
async function fireFirstBatchInline(env: Env, c: CampaignRow | null): Promise<number> {
  if (!c) return 0;
  const t = nowSec();
  const pick = await env.DB.prepare(
    `SELECT * FROM mailer_outbox
      WHERE campaign_id=? AND status='pending'
        AND (send_at IS NULL OR send_at <= ?)
      ORDER BY seq ASC LIMIT ?`
  )
    .bind(c.id, t, c.batch_size)
    .all<OutboxRow>();
  const rows = (pick.results || []) as OutboxRow[];
  if (rows.length === 0) return 0;

  const ids = rows.map((r) => r.id);
  await env.DB.prepare(
    `UPDATE mailer_outbox SET status='sending' WHERE id IN (${ids.map(() => "?").join(",")})`
  )
    .bind(...ids)
    .run();

  const attachments = await buildAttachments(env, c.id);
  const items = rows.map((r) => ({
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
    headers: { "X-Mailer": "asterick-mailer" },
  }));

  const results = await sendBatch(env, items);
  let sent = 0;
  for (let i = 0; i < rows.length; i++) {
    const res = results[i] || { ok: false, error: "no result" };
    if (res.ok) {
      sent++;
      await env.DB.prepare(
        "UPDATE mailer_outbox SET status='sent', resend_id=?, sent_at=? WHERE id=?"
      )
        .bind(res.resendId || null, t, rows[i].id)
        .run();
    } else {
      await env.DB.prepare(
        "UPDATE mailer_outbox SET status='failed', error=?, retry_count=retry_count+1, next_retry_at=? WHERE id=?"
      )
        .bind((res.error || "").slice(0, 500), t + 300, rows[i].id)
        .run();
    }
  }
  await recomputeCounts(env, c.id);
  await env.DB.prepare(
    "UPDATE mailer_campaigns SET next_run_at=?, updated_at=? WHERE id=?"
  )
    .bind(t + Math.max(c.interval_minutes, 1) * 60, t, c.id)
    .run();
  return sent;
}

// ------------------------------------------------------------------
// Campaign read / control
// ------------------------------------------------------------------
authed.get("/api/campaigns", async (c) => {
  const list = await listCampaigns(c.env, 200);
  return c.json({ campaigns: list });
});

authed.get("/api/campaigns/:id", async (c) => {
  const id = c.req.param("id");
  const campaign = await getCampaign(c.env, id);
  if (!campaign) return c.json({ error: "not found" }, 404);
  const outbox = await listOutboxForCampaign(c.env, id, 5000);
  const attachments = await listAttachmentsFor(c.env, id);
  return c.json({ campaign, outbox, attachments });
});

authed.post("/api/campaigns/:id/pause", async (c) => {
  await setCampaignStatus(c.env, c.req.param("id"), "paused");
  return c.json({ ok: true });
});

authed.post("/api/campaigns/:id/resume", async (c) => {
  const id = c.req.param("id");
  const t = nowSec();
  // On resume, set next_run_at to now so the cron picks it up immediately.
  await c.env.DB.prepare(
    "UPDATE mailer_campaigns SET status='active', next_run_at=?, updated_at=? WHERE id=?"
  )
    .bind(t, t, id)
    .run();
  return c.json({ ok: true });
});

authed.post("/api/campaigns/:id/test", zValidator("json", TestSendSchema), async (c) => {
  const { testEmail } = c.req.valid("json");
  const campaign = await getCampaign(c.env, c.req.param("id"));
  if (!campaign) return c.json({ error: "not found" }, 404);
  // Use the first outbox row as the sample.
  const sample = await c.env.DB.prepare(
    "SELECT * FROM mailer_outbox WHERE campaign_id=? ORDER BY seq ASC LIMIT 1"
  )
    .bind(campaign.id)
    .first<OutboxRow>();
  if (!sample) return c.json({ error: "no rows to preview" }, 400);

  const attachments = await buildAttachments(c.env, campaign.id);
  const res = await sendOne(c.env, {
    from: campaign.sender_address,
    to: testEmail,
    subject: `[TEST] ${sample.subject_rendered}`,
    html: sample.body_rendered,
    replyTo: campaign.reply_to || undefined,
    attachments: attachments.length ? attachments : undefined,
    tags: [{ name: "campaign_id", value: campaign.id }, { name: "test", value: "1" }],
    headers: { "X-Mailer": "asterick-mailer" },
  });
  return c.json(res);
});

authed.delete("/api/campaigns/:id", async (c) => {
  const id = c.req.param("id");
  // Best-effort: also delete R2 objects for attachments.
  const atts = await listAttachmentsFor(c.env, id);
  for (const a of atts) {
    try {
      await c.env.ATTACH.delete(a.r2_key);
    } catch {
      /* ignore */
    }
  }
  await deleteCampaign(c.env, id);
  return c.json({ ok: true });
});

// CSV export of outbox results.
authed.get("/api/campaigns/:id/export", async (c) => {
  const id = c.req.param("id");
  const outbox = await listOutboxForCampaign(c.env, id, 100_000);
  const csv = rowsToCsv(
    ["seq", "email", "status", "resend_id", "sent_at", "retry_count", "error"],
    outbox.map((r) => ({
      seq: r.seq,
      email: r.to_email,
      status: r.status,
      resend_id: r.resend_id || "",
      sent_at: r.sent_at ? new Date(r.sent_at * 1000).toISOString() : "",
      retry_count: r.retry_count,
      error: r.error || "",
    }))
  );
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="campaign-${id}.csv"`,
    },
  });
});

// Live preview of a subject/body with sample merge data (no send).
authed.post("/api/preview", async (c) => {
  const body = await c.req.json<{
    subjectTemplate?: string;
    bodyTemplate?: string;
    sampleData?: Record<string, string>;
  }>();
  const subject = renderMerge(body.subjectTemplate || "", body.sampleData || {});
  const html = renderMerge(body.bodyTemplate || "", body.sampleData || {});
  const tags = extractTags(body.subjectTemplate || "", body.bodyTemplate || "");
  return c.json({ subject, html, tags });
});

// ------------------------------------------------------------------
// Resend webhook — records delivery/open/click/bounce events.
// Secured by a query-string shared secret so it needs no session.
// Configure the webhook URL in Resend as:
//   https://mailer.asterick.tech/api/webhooks/resend?key=<WEBHOOK_SECRET>
// ------------------------------------------------------------------
app.post("/api/webhooks/resend", async (c) => {
  // Secured by a shared secret in the query string (set SESSION_SECRET via wrangler).
  // In Resend, point the webhook at:
  //   https://mailer.asterick.tech/api/webhooks/resend?key=<SESSION_SECRET>
  const expected = c.env.SESSION_SECRET;
  const got = new URL(c.req.url).searchParams.get("key") || "";
  if (!expected || got !== expected) {
    return c.json({ error: "forbidden" }, 403);
  }
  const payload = await c.req.json();
  const events = Array.isArray(payload?.events) ? payload.events : [payload];
  for (const ev of events) {
    const tags = (ev?.data?.tags || []) as Array<{ name: string; value: string }>;
    const campaignId = tags.find((t) => t.name === "campaign_id")?.value || null;
    const outboxId = tags.find((t) => t.name === "outbox_id")?.value || null;
    await recordEvent(c.env, {
      campaignId,
      outboxId,
      eventType: String(ev?.type || "unknown"),
      resendId: ev?.data?.email_id || ev?.data?.id || null,
      payload: JSON.stringify(ev).slice(0, 2000),
    });
    // Reflect bounce/failed status back onto the outbox row.
    if (outboxId && ["email.bounced", "email.delivery_failed", "bounced", "failed"].includes(ev?.type)) {
      await c.env.DB.prepare(
        "UPDATE mailer_outbox SET status='failed', error=? WHERE id=? AND status='sent'"
      )
        .bind(String(ev?.type), outboxId)
        .run();
    }
  }
  return c.json({ ok: true });
});

// Mount authed routes.
app.route("/", authed);

// ------------------------------------------------------------------
// Cron handler
// ------------------------------------------------------------------
export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // controller.cron tells you which trigger fired (we only have one).
    void controller;
    ctx.waitUntil(runScheduler(env));
  },
} satisfies ExportedHandler<Env>;
