/* Mailer dashboard client. Vanilla JS. Parses Excel in the browser with
   SheetJS, posts JSON to the Worker API. All real validation is server-side. */
"use strict";

// ============================================================
// State
// ============================================================
const state = {
  rows: [],
  headers: [],
  mergeKeys: [],
  // True when EVERY parsed row carries its own Subject AND Body —
  // then the campaign-level templates are optional fallbacks only.
  rowsSelfContained: false,
  attachments: [],
  scheduleMode: "now",
  detailId: null,
  pollTimer: null,
  reducedMotion: false,
  currentStep: 1,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)].filter(Boolean);

// ============================================================
// Helpers
// ============================================================
function toast(msg, isError = false) {
  const t = $("#toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.toggle("error", !!isError);
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 4000);
}

function fmtDate(secs) {
  if (!secs) return "—";
  return new Date(secs * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function pct(c) {
  if (!c || !c.total_rows) return 0;
  return Math.round(((c.sent_count + c.failed_count) / c.total_rows) * 100);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ============================================================
// Reduced motion + reveal
// ============================================================
(function initReducedMotion() {
  const mq = matchMedia("(prefers-reduced-motion: reduce)");
  state.reducedMotion = mq.matches;
  mq.addEventListener("change", (e) => (state.reducedMotion = e.matches));
})();

function initReveal() {
  if (state.reducedMotion) return;
  const obs = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("reveal-visible");
          obs.unobserve(entry.target);
        }
      });
    },
    { rootMargin: "60px", threshold: 0 }
  );
  $$(".reveal").forEach((el) => obs.observe(el));
}

// ============================================================
// API
// ============================================================
async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  let body = null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) body = await res.json().catch(() => null);
  else body = await res.text().catch(() => null);
  if (!res.ok) {
    const msg = (body && body.error) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ============================================================
// Auth
// ============================================================
async function checkAuth() {
  try {
    const r = await api("/api/session");
    if (r.authenticated) showApp();
    else showLogin();
  } catch {
    showLogin();
  }
}
function showLogin() {
  $("#app-view").hidden = true;
  $("#login-view").hidden = false;
  if ($("#login-password")) $("#login-password").focus();
}
function showApp() {
  $("#login-view").hidden = true;
  $("#app-view").hidden = false;
  initReveal();
  showView("dashboard");
  loadSenders();
  loadCampaigns();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#login-error");
  if (err) err.hidden = true;
  const pw = $("#login-password") ? $("#login-password").value : "";
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ password: pw }) });
    if ($("#login-password")) $("#login-password").value = "";
    showApp();
  } catch {
    if (err) { err.textContent = "Wrong password."; err.hidden = false; }
  }
});

$("#logout-btn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

// ============================================================
// Theme
// ============================================================
(function initTheme() {
  const saved = localStorage.getItem("mailer-theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
  else if (matchMedia("(prefers-color-scheme: dark)").matches)
    document.documentElement.setAttribute("data-theme", "dark");
})();
$("#theme-toggle").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") || "light";
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("mailer-theme", next);
});

// ============================================================
// View switching
// ============================================================
function showView(name) {
  $$(".view").forEach((v) => (v.hidden = true));
  const el = $(`#view-${name}`);
  if (el) el.hidden = false;
  $$(".nav-item[data-view]").forEach((n) =>
    n.classList.toggle("active", n.dataset.view === name)
  );
  if (name === "dashboard") loadCampaigns();
  if (name === "new") resetWizard();
}

document.body.addEventListener("click", (e) => {
  const t = e.target.closest("[data-view]");
  if (t) {
    showView(t.dataset.view);
    e.preventDefault();
  }
});

// ============================================================
// Wizard (4-step new campaign flow)
// ============================================================
function resetWizard() {
  state.currentStep = 1;
  showStep(1);
}

function showStep(n) {
  state.currentStep = n;
  $$(".wizard-step").forEach((s) =>
    s.classList.toggle("active", Number(s.dataset.step) === n)
  );
  $$("#wizard-head .dot").forEach((d) => {
    const i = Number(d.dataset.dot);
    d.classList.toggle("current", i === n);
    d.classList.toggle("done", i < n);
  });
  const back = $("#btn-back");
  const next = $("#btn-next");
  const create = $("#btn-create");
  if (back) back.hidden = n === 1;
  if (next) next.hidden = n === 4;
  if (create) create.hidden = n !== 4;
  if (n === 4) renderReview();
}

function validateStep(n) {
  if (n === 1) {
    if (!state.rows.length) { toast("Upload an Excel file first", true); return false; }
    return true;
  }
  if (n === 2) {
    if (!$("#f-name").value.trim()) { toast("Enter a campaign name", true); return false; }
    if (!$("#f-sender").value) { toast("Pick a sender", true); return false; }
    // Subject/Body templates are optional when every row provides its own.
    if (!state.rowsSelfContained) {
      if (!$("#f-subject").value.trim()) {
        toast("Your sheet is missing Subject for some rows — enter a subject template as fallback", true);
        return false;
      }
      if (!$("#f-body").value.trim()) {
        toast("Your sheet is missing Body for some rows — enter a body template as fallback", true);
        return false;
      }
    }
    return true;
  }
  if (n === 3) {
    if (state.scheduleMode === "datetime") {
      const v = $("#f-scheduledat").value;
      if (!v) { toast("Pick a date and time", true); return false; }
    }
    return true;
  }
  return true;
}

function renderReview() {
  const el = $("#review-summary");
  if (!el) return;
  const mode = state.scheduleMode;
  const sender = $("#f-sender").value || "—";
  const recur = $("#f-recur-freq").value;
  const tracking = $("#f-tracking").checked ? "On" : "Off";
  const sample = state.rows[0] || {};
  const subjectRendered = ($("#f-subject").value || sample.subject || "").replace(/\{\{(\w+)\}\}/g, (_, k) => sample[k] || "");
  const modeLabel = mode === "now" ? "Send now (first batch immediately)"
    : mode === "datetime" ? `At ${$("#f-scheduledat").value || "—"}`
    : "Interval drip";
  el.innerHTML = `
    <div class="review-grid">
      <div><span class="review-lbl">Recipients</span><span class="review-val">${state.rows.length} rows</span></div>
      <div><span class="review-lbl">From</span><span class="review-val">${escapeHtml(sender)}</span></div>
      <div><span class="review-lbl">Subject</span><span class="review-val">${escapeHtml(subjectRendered)}</span></div>
      <div><span class="review-lbl">Schedule</span><span class="review-val">${escapeHtml(modeLabel)}</span></div>
      <div><span class="review-lbl">Interval</span><span class="review-val">${$("#f-interval").value} min · batch ${$("#f-batch").value}</span></div>
      <div><span class="review-lbl">Tracking</span><span class="review-val">${tracking}</span></div>
      ${recur ? `<div><span class="review-lbl">Recurring</span><span class="review-val">${escapeHtml(recur)}</span></div>` : ""}
      <div><span class="review-lbl">Attachments</span><span class="review-val">${state.attachments.length}</span></div>
    </div>
    <p class="muted" style="margin-top:14px">Merge tags available: ${
      state.mergeKeys.length ? state.mergeKeys.map((k) => "<code>{{" + escapeHtml(k) + "}}</code>").join(" ") : "none"
    }</p>`;
}

// Show/hide the "sheet provides its own" note + relax the required markers.
function updateTemplateNote() {
  const note = $("#template-note");
  if (!note) return;
  const need = state.rows.length > 0 && !state.rowsSelfContained;
  note.hidden = !state.rowsSelfContained;
  if (note) {
    note.textContent = state.rowsSelfContained
      ? "Every row in your sheet carries its own Subject and Body — these templates are optional. Rows win; a template (if filled) is only the fallback."
      : "";
  }
  $$("#f-subject, #f-body").forEach((el) => el.required = need);
}

$("#btn-next").addEventListener("click", () => {
  if (validateStep(state.currentStep) && state.currentStep < 4) showStep(state.currentStep + 1);
});
$("#btn-back").addEventListener("click", () => {
  if (state.currentStep > 1) showStep(state.currentStep - 1);
});

// ============================================================
// Senders
// ============================================================
async function loadSenders() {
  try {
    const r = await api("/api/senders");
    const sel = $("#f-sender");
    if (!sel) return;
    if (!r.senders.length) {
      sel.innerHTML = '<option value="">— no Mailflare mailboxes found —</option>';
      return;
    }
    sel.innerHTML = "";
    for (const s of r.senders) {
      const opt = document.createElement("option");
      opt.value = s.address;
      opt.textContent = `${s.address}${s.displayName ? " — " + s.displayName : ""}${
        s.sendingEnabled ? "" : " (sending off)"
      }`;
      sel.appendChild(opt);
    }
  } catch (e) {
    toast("Could not load senders: " + e.message, true);
  }
}

// ============================================================
// Excel parsing (browser, SheetJS)
// ============================================================
const dropzone = $("#dropzone");
const fileInput = $("#file-input");

["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("drag");
  })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag");
  })
);
dropzone.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f) handleFile(f);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

function findKey(obj, candidates) {
  const lower = Object.keys(obj).reduce((m, k) => ((m[k.toLowerCase()] = k), m), {});
  for (const c of candidates) if (lower[c.toLowerCase()] !== undefined) return lower[c.toLowerCase()];
  return null;
}

async function handleFile(file) {
  const info = $("#file-info");
  if (info) { info.hidden = false; info.textContent = `Reading ${file.name}…`; }
  try {
    if (typeof XLSX === "undefined") {
      throw new Error("Excel parser (SheetJS) failed to load — check your network and try again.");
    }
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    if (!raw.length) throw new Error("No rows found in the first sheet.");

    const rows = [];
    for (const r of raw) {
      const eKey = findKey(r, ["Email", "email", "E-mail", "to", "To"]);
      const sKey = findKey(r, ["Subject", "subject", "title", "Title"]);
      const bKey = findKey(r, ["Body", "body", "message", "Message", "html", "HTML"]);
      const tKey = findKey(r, ["SendAt", "sendAt", "send_at", "SendAtTime"]);
      if (!eKey) throw new Error('Column "Email" is required.');
      const email = String(r[eKey] ?? "").trim();
      if (!email) continue;
      const out = { email };
      if (sKey && r[sKey]) out.subject = String(r[sKey]);
      if (bKey && r[bKey]) out.body = String(r[bKey]);
      if (tKey && r[tKey]) {
        const d = new Date(r[tKey]);
        if (!isNaN(d)) out.sendAt = d.toISOString();
      }
      for (const [k, v] of Object.entries(r)) {
        if ([eKey, sKey, bKey, tKey].includes(k)) continue;
        if (["email", "subject", "body", "sendat", "send_at"].includes(k.toLowerCase())) continue;
        out[k] = v === null || v === undefined ? "" : String(v);
      }
      rows.push(out);
    }

    state.rows = rows;
    // Detect sheet-provided Subject + Body: templates become optional.
    state.rowsSelfContained =
      rows.length > 0 && rows.every((r) => (r.subject || "").trim()) && rows.every((r) => (r.body || "").trim());
    updateTemplateNote();
    state.headers = Object.keys(rows[0]);
    state.mergeKeys = state.headers.filter(
      (h) => !["email", "subject", "body", "sendat", "send_at"].includes(h.toLowerCase())
    );

    if (info) {
      info.innerHTML = `<strong>${escapeHtml(file.name)}</strong> — ${rows.length} rows · ${
        state.mergeKeys.length ? "merge tags: " + state.mergeKeys.map((k) => "<code>{{" + escapeHtml(k) + "}}</code>").join(", ") : "no merge tags"
      }`;
    }
    renderPreview(rows);
  } catch (e) {
    if (info) {
      info.innerHTML = `<span class="error">${escapeHtml(e.message)}</span>`;
      const sp = $("#sheet-preview");
      if (sp) sp.hidden = true;
    }
    state.rows = [];
  }
}

function renderPreview(rows) {
  const wrap = $("#sheet-preview");
  if (!wrap) return;
  const cols = Object.keys(rows[0]).slice(0, 8);
  const head = cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const body = rows
    .slice(0, 5)
    .map((r) => "<tr>" + cols.map((c) => `<td>${escapeHtml(String(r[c] ?? "").slice(0, 60))}</td>`).join("") + "</tr>")
    .join("");
  wrap.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${
    rows.length > 5 ? `<p class="muted" style="padding:8px 12px">+ ${rows.length - 5} more rows…</p>` : ""
  }`;
  wrap.hidden = false;
}

// ============================================================
// Schedule mode (interval field stays visible in every mode)
// ============================================================
$("#schedule-mode").addEventListener("click", (e) => {
  const b = e.target.closest(".seg-btn");
  if (!b) return;
  state.scheduleMode = b.dataset.mode;
  $$("#schedule-mode .seg-btn").forEach((x) => x.classList.toggle("active", x === b));
  $("#field-datetime").hidden = state.scheduleMode !== "datetime";
  // interval field stays visible in ALL modes (including "now")
});

// ============================================================
// Attachments
// ============================================================
$("#attach-input").addEventListener("change", async () => {
  const files = [...($("#attach-input").files || [])];
  for (const f of files) {
    if (f.size > 10 * 1024 * 1024) { toast(`${f.name} is over 10 MB — skipped`, true); continue; }
    if (state.attachments.length >= 10) { toast("Max 10 attachments", true); break; }
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch("/api/attachments", { method: "POST", body: fd, credentials: "same-origin" });
      if (!res.ok) throw new Error("upload failed");
      const j = await res.json();
      state.attachments.push({ id: j.id, filename: j.filename, size: j.size });
      renderAttachments();
    } catch {
      toast(`Failed to upload ${f.name}`, true);
    }
  }
  $("#attach-input").value = "";
});

function renderAttachments() {
  const list = $("#attach-list");
  if (!list) return;
  list.innerHTML = state.attachments
    .map((a) => `<div class="attach-item"><span>${escapeHtml(a.filename)} · ${Math.round(a.size / 1024)} KB</span></div>`)
    .join("");
}

// ============================================================
// Live preview (gated until subject + body are non-empty)
// ============================================================
$("#btn-preview").addEventListener("click", async () => {
  const subject = $("#f-subject") ? $("#f-subject").value : "";
  const body = $("#f-body") ? $("#f-body").value : "";
  const sample = state.rows[0] || {};
  // Fall back to the first row's own Subject/Body when templates are empty
  // and the sheet provides them.
  const effSubject = subject.trim() || sample.subject || "";
  const effBody = body.trim() || sample.body || "";
  if (!effSubject.trim() || !effBody.trim()) {
    toast("Fill the subject and body templates first (or upload a sheet with Subject + Body columns)", true);
    return;
  }
  try {
    const r = await api("/api/preview", {
      method: "POST",
      body: JSON.stringify({ subjectTemplate: effSubject, bodyTemplate: effBody, sampleData: sample }),
    });
    $("#preview-subject").textContent = r.subject || "(empty)";
    const frame = $("#preview-frame");
    if (frame) frame.srcdoc = r.html || "";
    $("#preview-modal").hidden = false;
  } catch (e) {
    toast("Preview failed: " + e.message, true);
  }
});
$("#preview-close").addEventListener("click", () => ($("#preview-modal").hidden = true));

// ============================================================
// Create campaign
// ============================================================
$("#campaign-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("#create-status");
  if (!state.rows.length) { toast("Upload an Excel file first", true); return; }
  const sender = $("#f-sender") ? $("#f-sender").value : "";
  if (!sender) { toast("Pick a sender", true); return; }
  const mode = state.scheduleMode;
  const recurringFreq = $("#f-recur-freq") ? $("#f-recur-freq").value : "";
  const recurringUntil = $("#f-recur-until") ? $("#f-recur-until").value : "";

  const payload = {
    name: $("#f-name") ? $("#f-name").value.trim() : "",
    senderAddress: sender,
    replyTo: $("#f-replyto")?.value || undefined,
    subjectTemplate: $("#f-subject") ? $("#f-subject").value : "",
    bodyTemplate: $("#f-body") ? $("#f-body").value : "",
    rows: state.rows,
    scheduleMode: mode,
    scheduledAt: mode === "datetime" ? ($("#f-scheduledat") ? $("#f-scheduledat").value : undefined) : undefined,
    intervalMinutes: parseInt($("#f-interval")?.value, 10) || 30,
    batchSize: parseInt($("#f-batch")?.value, 10) || 5,
    trackingEnabled: $("#f-tracking")?.checked || false,
    recurring: recurringFreq ? { freq: recurringFreq, until: recurringUntil || undefined } : undefined,
    attachmentIds: state.attachments.map((a) => a.id),
  };

  const btn = $("#btn-create");
  if (btn) btn.disabled = true;
  if (status) status.textContent = "Creating campaign…";
  try {
    const r = await api("/api/campaigns", { method: "POST", body: JSON.stringify(payload) });
    toast(`Campaign created${r.sentNow ? " — sent " + r.sentNow + " now" : ""}`);
    state.rows = [];
    state.attachments = [];
    if ($("#campaign-form")) $("#campaign-form").reset();
    if ($("#file-info")) $("#file-info").hidden = true;
    if ($("#sheet-preview")) $("#sheet-preview").hidden = true;
    renderAttachments();
    state.detailId = r.campaign ? r.campaign.id : null;
    showView("dashboard");
    loadCampaigns();
  } catch (e) {
    if (status) status.innerHTML = `<span class="error">${escapeHtml(e.message)}</span>`;
    toast(e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ============================================================
// Campaign list
// ============================================================
async function loadCampaigns() {
  const wrap = $("#campaign-list");
  if (!wrap) return;
  wrap.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const r = await api("/api/campaigns");
    if (!r.campaigns.length) {
      wrap.innerHTML = '<div class="card"><p class="muted">No campaigns yet. Click <strong>New campaign</strong> to send your first batch.</p></div>';
      return;
    }
    wrap.innerHTML = r.campaigns.map(campCardHtml).join("");
    wrap.querySelectorAll("[data-open]").forEach((el) =>
      el.addEventListener("click", () => openDetail(el.dataset.open))
    );
  } catch (e) {
    wrap.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
  }
}

function campCardHtml(c) {
  const p = pct(c);
  return `<div class="card camp-card" data-open="${escapeHtml(c.id)}" role="button">
    <div>
      <p class="camp-title">${escapeHtml(c.name)}</p>
      <p class="camp-meta">${escapeHtml(c.sender_address)} · ${c.total_rows} recipients · ${fmtDate(c.created_at)}</p>
      <div class="progress"><span style="width:${p}%"></span></div>
    </div>
    <div class="row gap">
      <span class="badge status-${escapeHtml(c.status)}">${escapeHtml(c.status)}</span>
      <span class="muted">${c.sent_count}/${c.total_rows} sent</span>
    </div>
  </div>`;
}

// ============================================================
// Campaign detail
// ============================================================
async function openDetail(id) {
  state.detailId = id;
  showView("detail");
  await loadDetail();
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    const c = await api(`/api/campaigns/${id}`).catch(() => null);
    if (!c) return;
    renderDetail(c);
    loadInsights(id);
    if (c.campaign && c.campaign.status !== "active") {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }, 5000);
}

async function loadDetail() {
  const title = $("#detail-title");
  if (!title) return;
  title.textContent = "Loading…";
  try {
    const r = await api(`/api/campaigns/${state.detailId}`);
    renderDetail(r);
    loadInsights(state.detailId);
  } catch (e) {
    title.textContent = "Error";
    if ($("#detail-sub")) $("#detail-sub").textContent = e.message;
  }
}

async function loadInsights(id) {
  const statsEl = $("#insight-stats");
  const eventsEl = $("#insight-events");
  if (!statsEl || !eventsEl) return;
  try {
    const r = await api(`/api/campaigns/${id}/events`);
    const n = r.counts || {};
    statsEl.innerHTML = `
      <div class="stat"><div class="num" style="color:var(--ok)">${n.delivered || 0}</div><div class="lbl">Delivered</div></div>
      <div class="stat"><div class="num">${n.opened || 0}</div><div class="lbl">Opened</div></div>
      <div class="stat"><div class="num">${n.clicked || 0}</div><div class="lbl">Clicked</div></div>
      <div class="stat"><div class="num" style="color:var(--destructive)">${n.bounced || 0}</div><div class="lbl">Bounced</div></div>`;
    const events = r.events || [];
    if (!events.length) { eventsEl.hidden = true; eventsEl.innerHTML = ""; return; }
    eventsEl.hidden = false;
    eventsEl.innerHTML = `<table>
      <thead><tr><th>When</th><th>Event</th><th>Resend ID</th></tr></thead>
      <tbody>${events.slice(0, 50).map((ev) => `<tr>
        <td>${fmtDate(ev.created_at)}</td>
        <td><span class="badge">${escapeHtml(ev.event_type)}</span></td>
        <td>${escapeHtml(ev.resend_id || "—")}</td>
      </tr>`).join("")}</tbody></table>`;
  } catch (e) {
    statsEl.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
    eventsEl.hidden = true;
  }
}

function renderDetail(r) {
  const c = r.campaign;
  if ($("#detail-title")) $("#detail-title").textContent = c ? c.name : "";
  if ($("#detail-sub")) $("#detail-sub").textContent = c ? `${c.sender_address} · ${c.schedule_mode} · batch ${c.batch_size} every ${c.interval_minutes}m` : "";
  const p = pct(c);
  const now = Math.floor(Date.now() / 1000);
  const scheduled = (r.outbox || []).filter((o) => o.status === "pending" && o.send_at && o.send_at > now).length;
  if ($("#detail-stats")) {
    $("#detail-stats").innerHTML = `
      <div class="stat"><div class="num">${c ? c.total_rows : 0}</div><div class="lbl">Total</div></div>
      <div class="stat"><div class="num" style="color:var(--ok)">${c ? c.sent_count : 0}</div><div class="lbl">Sent</div></div>
      <div class="stat"><div class="num" style="color:var(--destructive)">${c ? c.failed_count : 0}</div><div class="lbl">Failed</div></div>
      <div class="stat"><div class="num">${scheduled}</div><div class="lbl">Scheduled</div></div>`;
  }
  if ($("#btn-pause")) $("#btn-pause").hidden = c && c.status !== "active";
  if ($("#btn-resume")) $("#btn-resume").hidden = c && c.status === "active";

  const rows = (r.outbox || []).slice(0, 200);
  if ($("#detail-outbox")) {
    $("#detail-outbox").innerHTML = `<table>
      <thead><tr><th>#</th><th>To</th><th>Status</th><th>Scheduled for</th><th>Sent</th><th>Resend ID</th><th>Error</th></tr></thead>
      <tbody>${rows.map((o) => `<tr>
        <td>${o.seq}</td>
        <td>${escapeHtml(o.to_email)}</td>
        <td><span class="badge status-${escapeHtml(o.status)}">${escapeHtml(o.status)}</span></td>
        <td>${o.send_at ? fmtDate(o.send_at) : "—"}</td>
        <td>${fmtDate(o.sent_at)}</td>
        <td>${escapeHtml(o.resend_id || "")}</td>
        <td>${escapeHtml((o.error || "").slice(0, 80))}</td>
      </tr>`).join("")}</tbody></table>${
      r.outbox && r.outbox.length > 200 ? `<p class="muted" style="padding:8px 12px">Showing first 200 of ${r.outbox.length} rows. Export CSV for the full report.</p>` : ""
    }`;
  }
}

$("#btn-pause").addEventListener("click", async () => {
  if (state.detailId) {
    await api(`/api/campaigns/${state.detailId}/pause`, { method: "POST" });
    toast("Paused");
    loadDetail();
  }
});
$("#btn-resume").addEventListener("click", async () => {
  if (state.detailId) {
    await api(`/api/campaigns/${state.detailId}/resume`, { method: "POST" });
    toast("Resumed");
    openDetail(state.detailId);
  }
});
$("#btn-delete").addEventListener("click", async () => {
  if (!confirm("Delete this campaign and all its outbox rows?")) return;
  if (state.detailId) {
    await api(`/api/campaigns/${state.detailId}`, { method: "DELETE" });
    toast("Deleted");
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    showView("dashboard");
    loadCampaigns();
  }
});
$("#btn-export").addEventListener("click", () => {
  if (state.detailId) window.location.href = `/api/campaigns/${state.detailId}/export`;
});

$("#btn-test").addEventListener("click", () => { if ($("#test-modal")) $("#test-modal").hidden = false; });
$("#test-cancel").addEventListener("click", () => { if ($("#test-modal")) $("#test-modal").hidden = true; });
$("#test-confirm").addEventListener("click", async () => {
  const email = $("#test-email") ? $("#test-email").value.trim() : "";
  if (!email) return;
  try {
    const r = await api(`/api/campaigns/${state.detailId}/test`, {
      method: "POST",
      body: JSON.stringify({ testEmail: email }),
    });
    toast(r.ok ? "Test sent" : "Test failed: " + (r.error || ""), !r.ok);
    if ($("#test-modal")) $("#test-modal").hidden = true;
  } catch (e) {
    toast(e.message, true);
  }
});

// ============================================================
// Boot
// ============================================================
checkAuth();
initReveal();
