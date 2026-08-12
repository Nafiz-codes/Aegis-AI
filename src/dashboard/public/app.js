/* -------------------------------------------------------------------------- */
/* Aegis-AI dashboard client                                                    */
/*   - subscribes to /api/timeline (SSE) for live pipeline events              */
/*   - polls /api/state every 2 s for store-backed KPIs / event table          */
/* -------------------------------------------------------------------------- */

const els = {
  clock: document.getElementById("clock"),
  threat: document.getElementById("threat"),
  threatLabel: document.querySelector(".threat-label"),
  kpiEvents: document.getElementById("kpi-events"),
  kpiDelivered: document.getElementById("kpi-delivered"),
  kpiFailed: document.getElementById("kpi-failed"),
  kpiUsers: document.getElementById("kpi-users"),
  eventsBody: document.getElementById("events-body"),
  eventsCount: document.getElementById("events-count"),
  timeline: document.getElementById("timeline"),
  timelineCount: document.getElementById("timeline-count"),
  decisions: document.getElementById("decisions"),
  decisionsCount: document.getElementById("decisions-count"),
  dispatchBody: document.getElementById("dispatch-body"),
  dispatchCount: document.getElementById("dispatch-count"),
};

const SEVERITIES = ["CRITICAL", "HIGH", "MODERATE", "LOW"];
const TIMELINE_CAP = 400;
const DECISION_CAP = 50;

let liveTimeline = [];
let liveDecisions = [];
const seenEvents = new Map();

/* -------------------------------------------------------------------------- */
/* SSE — live timeline                                                         */
/* -------------------------------------------------------------------------- */
function openStream() {
  const es = new EventSource("/api/timeline");
  for (const kind of ["detected","verified","severity","audience","decision","queued","sending","sent","delivered","failed","skipped","system","log","hello"]) {
    es.addEventListener(kind, (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        pushTimeline(payload);
        if (kind === "decision") pushDecision(payload);
      } catch {}
    });
  }
  es.onerror = () => {
    // Browser will auto-retry; close + reopen to reset backoff if needed.
    setTimeout(() => { if (es.readyState === 2) es.close(); openStream(); }, 1500);
  };
}

/* -------------------------------------------------------------------------- */
/* Polling — store snapshot                                                     */
/* -------------------------------------------------------------------------- */
async function pollState() {
  try {
    const res = await fetch("/api/state");
    if (!res.ok) return;
    const state = await res.json();
    renderState(state);
  } catch {}
}

/* -------------------------------------------------------------------------- */
/* Render                                                                      */
/* -------------------------------------------------------------------------- */
function renderState(state) {
  els.clock.textContent = state.clock;
  els.kpiEvents.textContent = String(state.counts.activeEvents);
  els.kpiDelivered.textContent = String(state.counts.deliveredAlerts);
  els.kpiFailed.textContent = String(state.counts.failedAlerts);
  els.kpiUsers.textContent = String(state.counts.activeSubscribers);

  setThreat(state.globalThreat);

  els.eventsCount.textContent = String(state.events.length);
  els.eventsBody.innerHTML = "";
  if (state.events.length === 0) {
    els.eventsBody.innerHTML = `<tr class="empty-row"><td colspan="7">Awaiting first verified event…</td></tr>`;
  } else {
    for (const ev of state.events) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><span class="chip chip-${ev.severity}">${ev.severity}</span></td>
        <td>
          <div style="font-weight:500">${escape(ev.title)}</div>
          <div style="color:var(--dim);font-size:11px;margin-top:2px">${escape(ev.type)}</div>
        </td>
        <td>
          <div>${escape(ev.sourceName)}</div>
          <div style="color:var(--dim);font-size:11px">${escape(ev.source)}</div>
        </td>
        <td>
          <div>${escape(ev.locationName || `${ev.lat.toFixed(2)}, ${ev.lon.toFixed(2)}`)}</div>
        </td>
        <td>
          <div>${escape(ev.clock)}</div>
          <div style="color:var(--dim);font-size:11px">${escape(formatDate(ev.observedAt))}</div>
        </td>
        <td>
          <div style="font-weight:500">${ev.affectedCount}</div>
          <div style="color:var(--dim);font-size:11px">${ev.channels.map(escape).join(" · ") || "—"}</div>
        </td>
        <td>
          ${renderDeliveryCounts(ev.deliveryCounts)}
        </td>
      `;
      els.eventsBody.appendChild(tr);
    }
  }

  // Dispatch table
  els.dispatchCount.textContent = String(state.recentAlerts.length);
  els.dispatchBody.innerHTML = "";
  if (state.recentAlerts.length === 0) {
    els.dispatchBody.innerHTML = `<tr class="empty-row"><td colspan="5">No alerts dispatched yet</td></tr>`;
  } else {
    for (const a of state.recentAlerts) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escape(a.clock)}</td>
        <td>${escape(a.recipient)}</td>
        <td>${escape(a.channel.toUpperCase())}</td>
        <td class="sev-cell sev-${a.severity}">${escape(a.severity)}</td>
        <td class="status-${a.status}">${escape(a.status.toUpperCase())}</td>
      `;
      els.dispatchBody.appendChild(tr);
    }
  }
}

function renderDeliveryCounts(d) {
  const parts = [];
  if (d.sent) parts.push(`<span class="status-delivered">${d.sent} sent</span>`);
  if (d.failed) parts.push(`<span class="status-failed">${d.failed} failed</span>`);
  if (d.skipped) parts.push(`<span class="status-skipped">${d.skipped} skipped</span>`);
  if (d.queued) parts.push(`<span class="status-queued">${d.queued} queued</span>`);
  return parts.length ? parts.join(" · ") : `<span style="color:var(--dim)">—</span>`;
}

function setThreat(level) {
  const cls = `threat threat-${level}`;
  if (els.threat.className !== cls) els.threat.className = cls;
  const labels = {
    GREEN: "SYSTEM NORMAL",
    AMBER: "ELEVATED THREAT",
    RED: "CRITICAL ALERT",
  };
  els.threatLabel.textContent = labels[level] ?? "UNKNOWN";
}

function pushTimeline(ev) {
  liveTimeline.unshift(ev);
  if (liveTimeline.length > TIMELINE_CAP) liveTimeline.length = TIMELINE_CAP;
  els.timelineCount.textContent = String(liveTimeline.length);
  // Only render the newest row for efficiency; full history isn't required.
  if (els.timeline.firstChild) els.timeline.removeChild(els.timeline.firstChild);
  els.timeline.prepend(buildTimelineRow(ev));
}

function buildTimelineRow(ev) {
  const row = document.createElement("div");
  row.className = "tl-row";
  const time = ev.ts ? clockOnly(ev.ts) : ev.clock ?? "";
  row.innerHTML = `
    <span class="tl-time">${escape(time)}</span>
    <span class="tl-tag tl-tag-${escape(ev.tag)}">${escape(ev.tag)}</span>
    <span class="tl-msg">${escape(ev.message)}</span>
  `;
  return row;
}

function pushDecision(ev) {
  const decision = {
    id: ev.seq,
    time: clockOnly(ev.ts),
    severity: ev.meta?.priority ?? ev.tag ?? "—",
    message: ev.message,
    reason: ev.meta?.reason ?? `provenance=${ev.meta?.provenance ?? "rules"}`,
  };
  liveDecisions.unshift(decision);
  if (liveDecisions.length > DECISION_CAP) liveDecisions.length = DECISION_CAP;
  els.decisionsCount.textContent = String(liveDecisions.length);
  renderDecisions();
}

function renderDecisions() {
  els.decisions.innerHTML = "";
  for (const d of liveDecisions) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="decision-head">
        <span class="chip chip-${d.severity}">${escape(d.severity)}</span>
        <span class="decision-time">${escape(d.time)}</span>
      </div>
      <div class="decision-msg">${escape(d.message)}</div>
      <div class="decision-reason">${escape(d.reason)}</div>
    `;
    els.decisions.appendChild(li);
  }
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */
function clockOnly(iso) {
  const d = new Date(iso);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function pad(n) { return String(n).padStart(2, "0"); }
function escape(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                   */
/* -------------------------------------------------------------------------- */
openStream();
pollState();
setInterval(pollState, 2000);
// Threat pulse + ops clock animation; SSE updates the actual values.
setInterval(() => {
  // no-op; the backend fills the clock via /api/state
}, 1000);