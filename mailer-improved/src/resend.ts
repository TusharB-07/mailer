// Resend API client: single + batch send, with attachments loaded from R2.
import type { Env, AttachmentRow } from "./types";

export interface EmailItem {
  from: string;
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
  attachments?: { filename: string; content: string }[]; // content = base64
  tags?: { name: string; value: string }[];
  headers?: Record<string, string>;
}

export interface SendResult {
  ok: boolean;
  resendId?: string;
  error?: string;
}

export async function loadAttachmentsFor(
  env: Env,
  campaignId: string
): Promise<AttachmentRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM mailer_attachments WHERE campaign_id = ? ORDER BY created_at ASC"
  )
    .bind(campaignId)
    .all<AttachmentRow>();
  return (res.results || []) as AttachmentRow[];
}

async function materialize(
  env: Env,
  rows: AttachmentRow[]
): Promise<{ filename: string; content: string }[]> {
  const out: { filename: string; content: string }[] = [];
  for (const a of rows) {
    const obj = await env.ATTACH.get(a.r2_key);
    if (!obj) continue;
    const buf = await obj.arrayBuffer();
    // base64 encode
    const bytes = new Uint8Array(buf);
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as unknown as number[]);
    }
    out.push({ filename: a.filename, content: btoa(bin) });
  }
  return out;
}

// Send a batch (1..N). Returns one result per input item, in order.
// Resend's /emails/batch accepts up to 100 emails per call.
export async function sendBatch(
  env: Env,
  items: EmailItem[]
): Promise<SendResult[]> {
  if (items.length === 0) return [];

  // Load attachments once per campaign (same for every email in it).
  // Caller may pre-supply attachments; otherwise we leave them off.
  const payload = items.map((it) => {
    const o: Record<string, unknown> = {
      from: it.from,
      to: it.to,
      subject: it.subject,
      html: it.html,
      tags: it.tags || [],
    };
    if (it.replyTo) o.reply_to = it.replyTo;
    if (it.attachments && it.attachments.length) o.attachments = it.attachments;
    if (it.headers) o.headers = it.headers;
    return o;
  });

  const url = `${env.RESEND_API_BASE}/emails/batch`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  // Resend batch returns 200 + array of {id} per email on success,
  // or 200 with a top-level {data:[...]} shape, or 422 on validation error.
  if (res.status === 200) {
    const body = await res.json() as
      | Array<{ id?: string; message?: string }>
      | { data: Array<{ id?: string; message?: string }> };
    const arr = Array.isArray(body) ? body : body?.data;
    if (Array.isArray(arr)) {
      return arr.map((r) =>
        r.id ? { ok: true, resendId: r.id } : { ok: false, error: r.message || "no id returned" }
      );
    }
    // Single-object success shape (rare for batch) — treat all as sent.
    return items.map(() => ({ ok: true, resendId: "sent" }));
  }

  // Non-200: entire batch failed. Surface the error to every item.
  let errText = `resend HTTP ${res.status}`;
  try {
    const j = await res.json();
    errText = JSON.stringify(j).slice(0, 500);
  } catch {
    try {
      errText = (await res.text()).slice(0, 500);
    } catch {
      /* keep default */
    }
  }
  return items.map(() => ({ ok: false, error: errText }));
}

// Send a single email (test send / preview). Returns the id.
export async function sendOne(env: Env, item: EmailItem): Promise<SendResult> {
  const [r] = await sendBatch(env, [item]);
  return r;
}

export async function buildAttachments(
  env: Env,
  campaignId: string
): Promise<{ filename: string; content: string }[]> {
  const rows = await loadAttachmentsFor(env, campaignId);
  return materialize(env, rows);
}
