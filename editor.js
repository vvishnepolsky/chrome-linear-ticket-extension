// editor.js — preview + annotate the capture, then file a Linear issue.
// Reads the capture straight from IndexedDB (shared across extension pages).

import { getCapture, putCapture, deleteCapture } from "./db.js";

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const params = new URLSearchParams(location.search);
const captureId = params.get("id");

let capture = null;
let baseImage = null; // HTMLImageElement for screenshots
let videoUrl = null;
let imageUrl = null; // object URL for blob-backed image captures

// ---- annotation state ----
const state = {
  tool: "select",
  color: "#E5484D",
  size: 4,
  shapes: [],
  drawing: false,
  start: null,
  current: null,
};

const canvas = $("canvas");
const ctx = canvas.getContext("2d");

init();

async function init() {
  if (!captureId) return fail("No capture id in URL.");
  try {
    capture = await getCapture(captureId);
  } catch (e) {
    return fail("Could not read capture: " + e.message);
  }
  if (!capture) return fail("Capture not found — it may have expired.");

  $("loading").classList.add("hidden");
  renderPreview();
  renderDiagnostics();
  prefillForm();
  wireForm();
  loadLinear();
  if (capture.note) setSubmitStatus("⚠ " + capture.note, "err");
}

function fail(msg) {
  $("loading").textContent = msg;
  $("loading").classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------
function renderPreview() {
  $("attach-kind").textContent = capture.kind === "video" ? "recording" : "screenshot";
  document.title = capture.kind === "video" ? "Captura — recording" : "Captura — screenshot";

  if (capture.kind === "video") {
    $("anno-toolbar").classList.add("hidden");
    const blob = capture.blob || new Blob([], { type: capture.mimeType });
    videoUrl = URL.createObjectURL(blob);
    const v = $("video");
    v.src = videoUrl;
    v.classList.remove("hidden");
    return;
  }

  // image — dataUrl for visible-tab shots, blob for full-page / area captures
  baseImage = new Image();
  baseImage.onload = () => {
    canvas.width = baseImage.naturalWidth;
    canvas.height = baseImage.naturalHeight;
    canvas.classList.remove("hidden");
    redraw();
    wireAnnotation();
  };
  baseImage.onerror = () => fail("Failed to load screenshot image.");
  if (capture.dataUrl) {
    baseImage.src = capture.dataUrl;
  } else if (capture.blob) {
    imageUrl = URL.createObjectURL(capture.blob);
    baseImage.src = imageUrl;
  } else {
    return fail("Capture has no image data.");
  }
}

// ---------------------------------------------------------------------------
// Annotation engine
// ---------------------------------------------------------------------------
function wireAnnotation() {
  // tools
  document.querySelectorAll("#tools .tool").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll("#tools .tool").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.tool = b.dataset.tool;
      canvas.dataset.tool = state.tool;
    };
  });
  canvas.dataset.tool = state.tool;

  // colors
  document.querySelectorAll("#colors .swatch").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll("#colors .swatch").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.color = b.dataset.color;
    };
  });

  $("undo").onclick = () => { state.shapes.pop(); redraw(); };
  $("clear").onclick = () => { state.shapes = []; redraw(); };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function toCanvasCoords(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (canvas.width / r.width),
    y: (e.clientY - r.top) * (canvas.height / r.height),
  };
}

function onDown(e) {
  if (state.tool === "select") return;
  const p = toCanvasCoords(e);

  if (state.tool === "text") {
    promptText(p, e.clientX, e.clientY);
    return;
  }

  state.drawing = true;
  state.start = p;
  if (state.tool === "pen") {
    state.current = { tool: "pen", color: state.color, size: state.size, points: [p] };
  } else {
    state.current = { tool: state.tool, color: state.color, size: state.size, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  }
}

function onMove(e) {
  if (!state.drawing) return;
  const p = toCanvasCoords(e);
  if (state.tool === "pen") {
    state.current.points.push(p);
  } else {
    state.current.x1 = p.x;
    state.current.y1 = p.y;
  }
  redraw();
}

function onUp() {
  if (!state.drawing) return;
  state.drawing = false;
  if (state.current) {
    // ignore zero-size drags
    const c = state.current;
    const tiny = c.tool !== "pen" && Math.abs(c.x1 - c.x0) < 3 && Math.abs(c.y1 - c.y0) < 3;
    if (!tiny) state.shapes.push(c);
  }
  state.current = null;
  redraw();
}

function promptText(p, clientX, clientY) {
  const input = $("text-input");
  input.classList.remove("hidden");
  input.style.left = clientX + "px";
  input.style.top = clientY + "px";
  input.style.color = state.color;
  input.value = "";
  input.focus();

  const commit = () => {
    const text = input.value.trim();
    input.classList.add("hidden");
    input.onblur = null;
    input.onkeydown = null;
    if (text) {
      state.shapes.push({ tool: "text", color: state.color, x: p.x, y: p.y, text, size: 22 });
      redraw();
    }
  };
  input.onblur = commit;
  input.onkeydown = (ev) => {
    if (ev.key === "Enter") commit();
    if (ev.key === "Escape") { input.classList.add("hidden"); input.onblur = null; }
  };
}

function redraw() {
  if (!baseImage) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(baseImage, 0, 0);
  const all = state.current ? state.shapes.concat([state.current]) : state.shapes;
  for (const s of all) drawShape(s);
}

function drawShape(s) {
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.size || 4;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  if (s.tool === "rect") {
    ctx.strokeRect(Math.min(s.x0, s.x1), Math.min(s.y0, s.y1), Math.abs(s.x1 - s.x0), Math.abs(s.y1 - s.y0));
  } else if (s.tool === "arrow") {
    drawArrow(s.x0, s.y0, s.x1, s.y1, s.size || 4);
  } else if (s.tool === "pen") {
    ctx.beginPath();
    s.points.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
    ctx.stroke();
  } else if (s.tool === "text") {
    ctx.font = `bold ${s.size || 22}px -apple-system, sans-serif`;
    ctx.textBaseline = "top";
    // halo for legibility
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(255,255,255,.9)";
    ctx.strokeText(s.text, s.x, s.y);
    ctx.fillStyle = s.color;
    ctx.fillText(s.text, s.x, s.y);
  } else if (s.tool === "blur") {
    const x = Math.min(s.x0, s.x1), y = Math.min(s.y0, s.y1);
    const w = Math.abs(s.x1 - s.x0), h = Math.abs(s.y1 - s.y0);
    if (w > 1 && h > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.filter = "blur(12px)";
      ctx.drawImage(baseImage, 0, 0);
      ctx.restore();
    }
  }
  ctx.restore();
}

function drawArrow(x0, y0, x1, y1, size) {
  const head = Math.max(12, size * 3);
  const ang = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - head * Math.cos(ang - Math.PI / 6), y1 - head * Math.sin(ang - Math.PI / 6));
  ctx.lineTo(x1 - head * Math.cos(ang + Math.PI / 6), y1 - head * Math.sin(ang + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function canvasToBlob() {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
function renderDiagnostics() {
  const m = capture.meta || {};
  const envRows = [
    ["URL", m.url],
    ["Title", m.title],
    ["User agent", m.userAgent],
    ["Platform", m.platform],
    ["Viewport", m.viewport ? `${m.viewport.width}×${m.viewport.height} @${m.viewport.dpr}x` : null],
    ["Screen", m.screen ? `${m.screen.width}×${m.screen.height}` : null],
    ["Language", m.language],
    ["Timezone", m.timezone],
    ["Network", m.connection ? m.connection.effectiveType : null],
    ["Online", m.online == null ? null : String(m.online)],
  ].filter(([, v]) => v != null && v !== "");
  $("env-body").innerHTML = envRows
    .map(([k, v]) => `<div class="env-row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`)
    .join("");
  $("env-count").textContent = envRows.length;
  if (envRows.length) $("env-details").open = true;

  const logs = capture.logs || [];
  const consoleLogs = logs.filter((l) => l.kind === "console" || l.kind === "error");
  $("console-count").textContent = consoleLogs.length;
  $("console-body").innerHTML =
    consoleLogs
      .map((l) => {
        if (l.kind === "error") {
          return `<div class="log-line error">⛔ ${esc(l.payload.message || "")}${l.payload.stack ? "\n" + esc(l.payload.stack) : ""}</div>`;
        }
        return `<div class="log-line lvl-${esc(l.payload.level)}">[${esc(l.payload.level)}] ${esc((l.payload.args || []).join(" "))}</div>`;
      })
      .join("") || `<div class="log-line">No console output captured.</div>`;

  const net = logs.filter((l) => l.kind === "network");
  $("network-count").textContent = net.length;
  $("network-body").innerHTML =
    net
      .map((l) => {
        const ok = l.payload.ok;
        return `<div class="net-line"><span class="net-status ${ok ? "ok" : "bad"}">${esc(l.payload.status || "ERR")}</span><span>${esc(l.payload.method || "")} ${esc(l.payload.url || "")} <span style="opacity:.6">(${esc(l.payload.durationMs ?? "?")}ms)</span></span></div>`;
      })
      .join("") || `<div class="log-line">No network requests captured.</div>`;
}

// ---------------------------------------------------------------------------
// Linear form
// ---------------------------------------------------------------------------
function prefillForm() {
  const m = capture.meta || {};
  const host = (() => { try { return new URL(m.url).host; } catch (_) { return ""; } })();
  if (host) $("title").value = `Bug on ${host}`;
}

async function loadLinear() {
  const { linearApiKey, defaultTeamId, defaultProjectId, defaultPriority, defaultStateId } =
    await chrome.storage.local.get(["linearApiKey", "defaultTeamId", "defaultProjectId", "defaultPriority", "defaultStateId"]);

  if (!linearApiKey) {
    $("no-key-warn").classList.remove("hidden");
    $("open-options").onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
    $("submit").disabled = true;
    return;
  }

  if (defaultPriority != null) $("priority").value = String(defaultPriority);

  try {
    const resp = await send({ type: "LINEAR_LIST_TEAMS" });
    if (!resp || !resp.ok) throw new Error(resp && resp.error);
    const teamSel = $("team");
    teamSel.innerHTML = "";
    for (const t of resp.teams) {
      const o = document.createElement("option");
      o.value = t.id;
      o.textContent = `${t.name} (${t.key})`;
      teamSel.appendChild(o);
    }
    teamSel.value = defaultTeamId && resp.teams.some((t) => t.id === defaultTeamId) ? defaultTeamId : (resp.teams[0] && resp.teams[0].id) || "";
    teamSel.onchange = () => onTeamChange(teamSel.value);
    await onTeamChange(teamSel.value, defaultProjectId, defaultStateId);
  } catch (err) {
    setSubmitStatus("Couldn't load Linear teams: " + (err.message || err), "err");
  }
}

async function onTeamChange(teamId, preselectProject, preselectState) {
  const projSel = $("project");
  const labelSel = $("labels");
  const stateSel = $("state");
  projSel.innerHTML = '<option value="">—</option>';
  labelSel.innerHTML = "";
  stateSel.innerHTML = '<option value="">Team default</option>';
  if (!teamId) return;

  const [proj, labels, states] = await Promise.all([
    send({ type: "LINEAR_LIST_PROJECTS", teamId }),
    send({ type: "LINEAR_LIST_LABELS", teamId }),
    send({ type: "LINEAR_LIST_STATES", teamId }),
  ]);

  if (proj && proj.ok) {
    for (const p of proj.projects) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      projSel.appendChild(o);
    }
    if (preselectProject) projSel.value = preselectProject;
  }
  if (states && states.ok) {
    for (const s of states.states) {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = s.name;
      stateSel.appendChild(o);
    }
    if (preselectState && states.states.some((s) => s.id === preselectState)) {
      stateSel.value = preselectState;
    }
  }
  if (labels && labels.ok) {
    for (const l of labels.labels) {
      const o = document.createElement("option");
      o.value = l.id;
      o.textContent = l.name;
      labelSel.appendChild(o);
    }
  }
}

function wireForm() {
  $("submit").onclick = onSubmit;
}

async function onSubmit() {
  const teamId = $("team").value;
  const title = $("title").value.trim();
  if (!teamId) return setSubmitStatus("Pick a team.", "err");
  if (!title) return setSubmitStatus("Add a title.", "err");

  $("submit").disabled = true;
  setSubmitStatus("Uploading capture & creating issue…", "busy");

  try {
    // Flatten annotations into the stored screenshot before upload. Update
    // both blob and dataUrl so whichever the uploader reads is annotated.
    if (capture.kind === "image" && state.shapes.length) {
      const blob = await canvasToBlob();
      capture.blob = blob;
      capture.dataUrl = await blobToDataUrl(blob);
      await putCapture(capture);
    }

    const labelIds = Array.from($("labels").selectedOptions).map((o) => o.value);

    const resp = await send({
      type: "CREATE_TICKET",
      captureId: capture.id,
      title,
      description: $("description").value,
      teamId,
      projectId: $("project").value || null,
      stateId: $("state").value || null,
      priority: Number($("priority").value || 0),
      labelIds,
      includeAttachment: $("include-attachment").checked,
    });

    if (!resp || !resp.ok) throw new Error(resp && resp.error);
    showSuccess(resp.issue);
  } catch (err) {
    setSubmitStatus("Failed: " + (err.message || err), "err");
    $("submit").disabled = false;
  }
}

function showSuccess(issue) {
  setSubmitStatus("", "");
  $("submit").classList.add("hidden");
  const el = $("success");
  el.classList.remove("hidden");
  el.innerHTML = `✅ Created <a href="${esc(issue.url)}" target="_blank">${esc(issue.identifier)}</a> — ${esc(issue.title)}<br><small>You can close this tab.</small>`;
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  if (imageUrl) URL.revokeObjectURL(imageUrl);
}

function setSubmitStatus(text, kind) {
  const el = $("submit-status");
  el.textContent = text;
  el.className = `submit-status ${kind || ""}`;
}

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
