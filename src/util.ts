// Small helpers: ids, time, csv, json.
export const nowSec = (): number => Math.floor(Date.now() / 1000);

// RFC4122-ish v4 using crypto.randomUUID (available in Workers).
export function newId(): string {
  return crypto.randomUUID();
}

// Trim + collapse whitespace; returns "" for null/undefined.
export function clean(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/\r/g, "").trim();
}

// Coerce any Excel cell value (string|number|boolean|null) to a clean string.
export function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    // Avoid scientific notation for big ids; keep ints clean.
    if (Number.isFinite(v) && Math.abs(v) < 1e21) {
      return Number.isInteger(v) ? String(v) : String(v);
    }
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  return clean(v);
}

// Validate an email address server-side (RFC-ish, pragmatic).
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
export function isEmail(s: string): boolean {
  if (!s || s.length > 254) return false;
  return EMAIL_RE.test(s);
}

// Quote a CSV field per RFC 4180.
export function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function rowsToCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const head = headers.map(csvField).join(",");
  const body = rows
    .map((r) => headers.map((h) => csvField(r[h] ?? "")).join(","))
    .join("\n");
  return head + "\n" + body + "\n";
}

// Safe JSON parse.
export function parseJson<T = unknown>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

// Constant-time string compare (for the password check).
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Next occurrence (unix seconds) for a recurring campaign.
export function nextOccurrence(
  freq: "daily" | "weekly" | "monthly",
  fromSec: number
): number {
  const d = new Date(fromSec * 1000);
  if (freq === "daily") {
    d.setUTCDate(d.getUTCDate() + 1);
  } else if (freq === "weekly") {
    d.setUTCDate(d.getUTCDate() + 7);
  } else {
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return Math.floor(d.getTime() / 1000);
}
