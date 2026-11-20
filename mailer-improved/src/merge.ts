// Merge-tag engine: substitute {{key}} placeholders in subject/body using
// per-recipient data coming from extra Excel columns.
// Also used for live preview and to detect which tags a template needs.

const TAG_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

export function renderMerge(
  template: string,
  data: Record<string, string>
): string {
  if (!template) return "";
  return template.replace(TAG_RE, (_, key: string) => {
    const v = data[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

// Extract unique tag names from a template (for UI hints + validation).
export function extractTags(...templates: string[]): string[] {
  const set = new Set<string>();
  for (const t of templates) {
    if (!t) continue;
    let m: RegExpExecArray | null;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(t)) !== null) {
      set.add(m[1]);
    }
  }
  return [...set];
}

// Build a merge-data object from a raw row, excluding the reserved columns.
const RESERVED = new Set(["email", "subject", "body", "sendat", "send_at", "name"]);
export function buildMergeData(
  row: Record<string, string>,
  reserved: string[] = []
): Record<string, string> {
  const reservedLower = new Set(
    [...RESERVED, ...reserved.map((r) => r.toLowerCase())]
  );
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    if (reservedLower.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}
