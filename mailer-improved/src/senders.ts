// Reads the live mailbox list from Mailflare's tables in the shared D1,
// reconstructing `local_part@hostname` and surfacing sending status.
import type { Env } from "./types";

export interface Sender {
  id: string;
  address: string;
  localPart: string;
  hostname: string;
  displayName: string | null;
  sendingEnabled: boolean;
  sendingProvider: string | null;
}

export async function listSenders(env: Env): Promise<Sender[]> {
  // Joins Mailflare's mailboxes + domains. Reads only — never writes.
  const res = await env.DB.prepare(
    `SELECT
        m.id            AS id,
        m.local_part    AS local_part,
        m.display_name  AS display_name,
        m.disabled      AS disabled,
        d.hostname      AS hostname,
        d.sending_enabled   AS sending_enabled,
        d.sending_provider  AS sending_provider
     FROM mailboxes m
     JOIN domains d ON d.id = m.domain_id
     WHERE m.disabled = 0
     ORDER BY d.hostname ASC, m.local_part ASC`
  ).all();

  const rows = (res.results || []) as Array<{
    id: string;
    local_part: string;
    display_name: string | null;
    disabled: number;
    hostname: string;
    sending_enabled: number;
    sending_provider: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    localPart: r.local_part,
    hostname: r.hostname,
    address: `${r.local_part}@${r.hostname}`,
    displayName: r.display_name,
    sendingEnabled: !!r.sending_enabled,
    sendingProvider: r.sending_provider,
  }));
}

// Verify a sender address the client posted actually exists as a mailbox
// in Mailflare (server-side, not trusting the client dropdown value).
export async function verifySender(
  env: Env,
  address: string
): Promise<{ ok: true; mailboxId: string } | { ok: false }> {
  const [localPart, hostname] = address.split("@");
  if (!localPart || !hostname) return { ok: false };
  const row = await env.DB.prepare(
    `SELECT m.id AS id
       FROM mailboxes m
       JOIN domains d ON d.id = m.domain_id
      WHERE m.local_part = ?1 AND d.hostname = ?2 AND m.disabled = 0
      LIMIT 1`
  )
    .bind(localPart.toLowerCase(), hostname.toLowerCase())
    .first<{ id: string }>();
  if (!row) return { ok: false };
  return { ok: true, mailboxId: row.id };
}
