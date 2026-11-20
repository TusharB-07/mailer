/* Mailer dashboard client. Vanilla JS. Parses Excel in the browser with
   SheetJS, posts JSON to the Worker API. All real validation is server-side. */
"use strict";

const state = {
  rows: [],        // parsed recipients: [{email, subject?, body?, sendAt?, ...merge}]
  headers: [],     // detected column order
  mergeKeys: [],   // extra columns usable as {{tags}}
  attachments: [], // [{id, filename, size}]
  scheduleMode: "now",
  detailId: null,
  pollTimer: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ----------------- tiny helpers -----------------
function toast(msg, isError) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("error", !!isError);
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3200);
}

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

// ----------------- auth -----------------
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
  $("#login-password").focus();
}
function showApp() {
  $("#login-view").hidden = true;
  $("#app-view").hidden = false;
  showView("dashboard");
  loadSenders();
  loadCampaigns();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#login-error");
  err.hidden = true;
  const pw = $("#login-password").value;
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ password: pw }) });
    $("#login-password").value = "";
    showApp();
  } catch (e2) {
    err.textContent = "Wrong password.";
    err.hidden = false;
  }
});

$("#logout-btn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

// ----------------- theme -----------------
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

// ----------------- view switching -----------------
function showView(name) {
  $$(".view").forEach((v) => (v.hidden = true));
  const el = $(`#view-${name}`);
  if (el) el.hidden = false;
  $$(".nav-item[data-view]").forEach((n) =>
    n.classList.toggle("active", n.dataset.view === name)
  );
  if (name === "dashboard") loadCampaigns();
}

document.body.addEventListener("click", (e) => {
  const t = e.target.closest("[data-view]");
  if (t) {
    showView(t.dataset.view);
    e.preventDefault();
  }
});

// ----------------- senders -----------------
async function loadSenders() {
  try {
    const r = await api("/api/senders");
    const sel = $("#f-sender");
    sel.innerHTML = "";
    if (!r.senders.length) {
      sel.innerHTML = '<option value="">— no Mailflare mailboxes found —</option>';
      return;
    }
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

// ----------------- excel parsing (browser, SheetJS) -----------------
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
  info.hidden = false;
  info.textContent = `Reading ${file.name}…`;
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    if (!raw.length) throw new Error("No rows found in the first sheet.");

    // Normalize each row: pull out reserved keys, keep the rest as merge data.
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
    state.headers = Object.keys(rows[0]);
    state.mergeKeys = state.headers.filter(
      (h) => !["email", "subject", "body", "sendat", "send_at"].includes(h.toLowerCase())
    );

    info.innerHTML = `<strong>${file.name}</strong> — ${rows.length} rows · ${
      state.mergeKeys.length ? "merge tags: " + state.mergeKeys.map((k) => "{{" + k + "}}").join(", ") : "no merge tags"
    }`;

    renderPreview(rows);
  } catch (e) {
    info.innerHTML = `<span class="error">${e.message}</span>`;
    $("#sheet-preview").hidden = true;
    state.rows = [];
  }
}

function renderPreview(rows) {
  const wrap = $("#sheet-preview");
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ----------------- schedule mode -----------------
$("#schedule-mode").addEventListener("click", (e) => {
  const b = e.target.closest(".seg-btn");
  if (!b) return;
  state.scheduleMode = b.dataset.mode;
  $$("#schedule-mode .seg-btn").forEach((x) => x.classList.toggle("active", x === b));
  $("#field-datetime").hidden = state.scheduleMode !== "datetime";
  $("#field-interval").hidden = state.scheduleMode === "now";
});

// ----------------- attachments -----------------
$("#attach-input").addEventListener("change", async () => {
  const files = [...$("#attach-input").files];
  for (const f of files) {
    if (f.size > 10 * 1024 * 1024) {
      toast(`${f.name} is over 10 MB — skipped`, true);
      continue;
    }
    if (state.attachments.length >= 10) {
      toast("Max 10 attachments", true);
      break;
    }
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch("/api/attachments", { method: "POST", body: fd, credentials: "same-origin" });
      if (!res.ok) throw new Error("upload failed");
      const j = await res.json();
      state.attachments.push({ id: j.id, filename: j.filename, size: j.size });
      renderAttachments();
    } catch (e) {
      toast(`Failed to upload ${f.name}`, true);
    }
  }
  $("#attach-input").value = "";
});

function renderAttachments() {
  const list = $("#attach-list");
  list.innerHTML = state.attachments
    .map(
      (a) => `<div class="attach-item"><span>${escapeHtml(a.filename)} · ${Math.round(a.size / 1024)} KB</span></div>`
    )
    .join("");
}

// ----------------- live preview -----------------
$("#btn-preview").addEventListener("click", async () => {
  const subject = $("#f-subject").value;
  const body = $("#f-body").value;
  const sample = state.rows[0] || {};
  try {
    const r = await api("/api/preview", {
      method: "POST",
      body: JSON.stringify({ subjectTemplate: subject, bodyTemplate: body, sampleData: sample }),
    });
    $("#preview-subject").textContent = r.subject || "(empty)";
    const frame = $("#preview-frame");
    frame.srcdoc = r.html || "";
    $("#preview-modal").hidden = false;
  } catch (e) {
    toast("Preview failed: " + e.message, true);
  }
});
$("#preview-close").addEventListener("click", () => ($("#preview-modal").hidden = true));

// ----------------- create campaign -----------------
$("#campaign-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("#create-status");
  if (!state.rows.length) {
    toast("Upload an Excel file first", true);
    return;
  }
  const sender = $("#f-sender").value;
  if (!sender) {
    toast("Pick a sender", true);
    return;
  }
  const mode = state.scheduleMode;
  const recurringFreq = $("#f-recur-freq").value;
  const recurringUntil = $("#f-recur-until").value;

  const payload = {
    name: $("#f-name").value.trim(),
    senderAddress: sender,
    replyTo: $("#f-replyto").value || undefined,
    subjectTemplate: $("#f-subject").value,
    bodyTemplate: $("#f-body").value,
    rows: state.rows,
    scheduleMode: mode,
    scheduledAt: mode === "datetime" ? $("#f-scheduledat").value : undefined,
    intervalMinutes: parseInt($("#f-interval").value, 10) || 30,
    batchSize: parseInt($("#f-batch").value, 10) || 5,
    trackingEnabled: $("#f-tracking").checked,
    recurring: recurringFreq ? { freq: recurringFreq, until: recurringUntil || undefined } : undefined,
    attachmentIds: state.attachments.map((a) => a.id),
  };

  $("#btn-create").disabled = true;
  status.textContent = "Creating campaign…";
  try {
    const r = await api("/api/campaigns", { method: "POST", body: JSON.stringify(payload) });
    toast(`Campaign created${r.sentNow ? " — sent " + r.sentNow + " now" : ""}`);
    // reset form
    state.rows = [];
    state.attachments = [];
    $("#campaign-form").reset();
    $("#file-info").hidden = true;
    $("#sheet-preview").hidden = true;
    renderAttachments();
    state.detailId = r.campaign.id;
    showView("dashboard");
    loadCampaigns();
  } catch (e) {
    status.innerHTML = `<span class="error">${e.message}</span>`;
    toast(e.message, true);
  } finally {
    $("#btn-create").disabled = false;
  }
});

// ----------------- campaign list -----------------
async function loadCampaigns() {
  const wrap = $("#campaign-list");
  wrap.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const r = await api("/api/campaigns");
    if (!r.campaigns.length) {
      wrap.innerHTML =
        '<div class="card"><p class="muted">No campaigns yet. Click <strong>New campaign</strong> to send your first batch.</p></div>';
      return;
    }
    wrap.innerHTML = r.campaigns.map(campCardHtml).join("");
    wrap.querySelectorAll("[data-open]").forEach((el) =>
      el.addEventListener("click", () => openDetail(el.dataset.open))
    );
  } catch (e) {
    wrap.innerHTML = `<p class="error">${e.message}</p>`;
  }
}

function campCardHtml(c) {
  const p = pct(c);
  return `<div class="card camp-card" data-open="${c.id}" role="button">
    <div>
      <p class="camp-title">${escapeHtml(c.name)}</p>
      <p class="camp-meta">${escapeHtml(c.sender_address)} · ${c.total_rows} recipients · ${fmtDate(c.created_at)}</p>
      <div class="progress"><span style="width:${p}%"></span></div>
    </div>
    <div class="row gap">
      <span class="badge ${c.status}">${c.status}</span>
      <span class="muted">${c.sent_count}/${c.total_rows} sent</span>
    </div>
  </div>`;
}

// ----------------- campaign detail -----------------
async function openDetail(id) {
  state.detailId = id;
  showView("detail");
  await loadDetail();
  // poll while active
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    const c = await api(`/api/campaigns/${id}`).catch(() => null);
    if (!c) return;
    renderDetail(c);
    loadInsights(id);
    if (c.campaign.status !== "active") {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }, 5000);
}

async function loadDetail() {
  const title = $("#detail-title");
  title.textContent = "Loading…";
  try {
    const r = await api(`/api/campaigns/${state.detailId}`);
    renderDetail(r);
    loadInsights(state.detailId);
  } catch (e) {
    title.textContent = "Error";
    $("#detail-sub").textContent = e.message;
  }
}

// Insights: delivered / opened / clicked / bounced counts + recent events.
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
      <div class="stat"><div class="num" style="color:var(--danger)">${n.bounced || 0}</div><div class="lbl">Bounced</div></div>`;

    const events = r.events || [];
    if (!events.length) {
      eventsEl.hidden = true;
      eventsEl.innerHTML = "";
      return;
    }
    eventsEl.hidden = false;
    eventsEl.innerHTML = `<table>
      <thead><tr><th>When</th><th>Event</th><th>Resend ID</th></tr></thead>
      <tbody>${events
        .slice(0, 50)
        .map(
          (ev) => `<tr>
        <td>${fmtDate(ev.created_at)}</td>
        <td><span class="badge">${escapeHtml(ev.event_type)}</span></td>
        <td>${escapeHtml(ev.resend_id || "—")}</td>
      </tr>`
        )
        .join("")}</tbody></table>`;
  } catch (e) {
    statsEl.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
    eventsEl.hidden = true;
  }
}

function renderDetail(r) {
  const c = r.campaign;
  $("#detail-title").textContent = c.name;
  $("#detail-sub").textContent = `${c.sender_address} · ${c.schedule_mode} · batch ${c.batch_size} every ${c.interval_minutes}m`;
  const p = pct(c);
  const now = Math.floor(Date.now() / 1000);
  const scheduled = (r.outbox || []).filter(
    (o) => o.status === "pending" && o.send_at && o.send_at > now
  ).length;
  $("#detail-stats").innerHTML = `
    <div class="stat"><div class="num">${c.total_rows}</div><div class="lbl">Total</div></div>
    <div class="stat"><div class="num" style="color:var(--ok)">${c.sent_count}</div><div class="lbl">Sent</div></div>
    <div class="stat"><div class="num" style="color:var(--danger)">${c.failed_count}</div><div class="lbl">Failed</div></div>
    <div class="stat"><div class="num" style="color:var(--accent)">${scheduled}</div><div class="lbl">Scheduled</div></div>
    <div class="stat"><div class="num">${c.total_rows - c.sent_count - c.failed_count}</div><div class="lbl">Pending</div></div>`;
  $("#btn-pause").hidden = c.status !== "active";
  $("#btn-resume").hidden = c.status === "active";

  const rows = (r.outbox || []).slice(0, 200);
  $("#detail-outbox").innerHTML = `<table>
    <thead><tr><th>#</th><th>To</th><th>Status</th><th>Scheduled for</th><th>Sent</th><th>Resend ID</th><th>Error</th></tr></thead>
    <tbody>${rows
      .map(
        (o) => `<tr>
        <td>${o.seq}</td>
        <td>${escapeHtml(o.to_email)}</td>
        <td><span class="badge ${o.status}">${o.status}</span></td>
        <td>${o.send_at ? fmtDate(o.send_at) : "—"}</td>
        <td>${fmtDate(o.sent_at)}</td>
        <td>${escapeHtml(o.resend_id || "")}</td>
        <td>${escapeHtml((o.error || "").slice(0, 80))}</td>
      </tr>`
      )
      .join("")}</tbody></table>${
    r.outbox.length > 200 ? `<p class="muted" style="padding:8px 12px">Showing first 200 of ${r.outbox.length} rows. Export CSV for the full report.</p>` : ""
  }`;
}

// detail controls
$("#btn-pause").addEventListener("click", async () => {
  await api(`/api/campaigns/${state.detailId}/pause`, { method: "POST" });
  toast("Paused");
  loadDetail();
});
$("#btn-resume").addEventListener("click", async () => {
  await api(`/api/campaigns/${state.detailId}/resume`, { method: "POST" });
  toast("Resumed");
  openDetail(state.detailId);
});
$("#btn-delete").addEventListener("click", async () => {
  if (!confirm("Delete this campaign and all its outbox rows?")) return;
  await api(`/api/campaigns/${state.detailId}`, { method: "DELETE" });
  toast("Deleted");
  clearInterval(state.pollTimer);
  showView("dashboard");
  loadCampaigns();
});
$("#btn-export").addEventListener("click", () => {
  window.location.href = `/api/campaigns/${state.detailId}/export`;
});

// test send modal
$("#btn-test").addEventListener("click", () => ($("#test-modal").hidden = false));
$("#test-cancel").addEventListener("click", () => ($("#test-modal").hidden = true));
$("#test-confirm").addEventListener("click", async () => {
  const email = $("#test-email").value.trim();
  if (!email) return;
  try {
    const r = await api(`/api/campaigns/${state.detailId}/test`, {
      method: "POST",
      body: JSON.stringify({ testEmail: email }),
    });
    toast(r.ok ? "Test sent" : "Test failed: " + (r.error || ""), !r.ok);
    $("#test-modal").hidden = true;
  } catch (e) {
    toast(e.message, true);
  }
});

// ----------------- boot -----------------
checkAuth();
