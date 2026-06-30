// editor.js — preview + annotate one or more captures that make up a single
// Linear issue, then file it. Captures are read straight from IndexedDB
// (shared across extension pages); a "draft" records which captures belong
// to this report and in what order. New captures taken while this tab is open
// are appended live (see background.js → addToDraft).

import { getCapture, putCapture, getDraft, putDraft, deleteCapture } from "./db.js";

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const params = new URLSearchParams(location.search);
const draftId = params.get("draft");
const legacyCaptureId = params.get("id"); // backward-compat with old single-capture links

// Each entry is the capture object from IndexedDB, enriched in memory with
// per-screenshot annotation `shapes`, a `caption`, and a cached thumbnail URL.
let captures = [];
let activeIndex = -1;

let baseImage = null; // HTMLImageElement for the active screenshot
let objUrl = null; // object URL backing the active image/video, revoked on switch

// ---- annotation tool state (shapes themselves live on each capture) ----
const tool = {
  tool: "select",
  color: "#E5484D",
  size: 4,
  drawing: false,
  start: null,
  current: null,
};

const canvas = $("canvas");
const ctx = canvas.getContext("2d");

init();

async function init() {
  wireAnnotation();
  wireForm();

  // Resolve the capture id list from the draft (or a legacy single id).
  let ids = [];
  if (draftId) {
    let draft = null;
    try {
      draft = await getDraft(draftId);
    } catch (e) {
      return fail("Could not read draft: " + e.message);
    }
    if (draft) ids = draft.captureIds.slice();
  } else if (legacyCaptureId) {
    ids = [legacyCaptureId];
  }
  if (!ids.length) return fail("No captures found — they may have expired.");

  for (const id of ids) {
    const cap = await getCapture(id);
    if (cap) captures.push(prep(cap));
  }
  if (!captures.length) return fail("Captures not found — they may have expired.");

  // Tell the worker this tab owns the draft so later captures append here.
  if (draftId) send({ type: "SET_DRAFT_TAB", draftId }).catch(() => {});

  $("loading").classList.add("hidden");
  renderFilmstrip();
  setActive(0);
  loadLinear();

  // Live-append captures taken after the editor opened.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "CAPTURA_CAPTURE_ADDED" && msg.draftId === draftId) {
      onCaptureAdded(msg.captureId);
    }
  });

  // Reconcile against the draft once, in case a capture landed while we were
  // still loading (before the listener above was attached).
  if (draftId) reconcileDraft();
}

async function reconcileDraft() {
  let draft = null;
  try {
    draft = await getDraft(draftId);
  } catch (_) {
    return;
  }
  if (!draft) return;
  for (const id of draft.captureIds) {
    if (!captures.some((c) => c.id === id)) await onCaptureAdded(id);
  }
}

function prep(cap) {
  cap.shapes = cap.shapes || [];
  cap.caption = cap.caption || "";
  cap._thumbUrl = null;
  return cap;
}

function fail(msg) {
  $("loading").textContent = msg;
  $("loading").classList.remove("hidden");
}

async function onCaptureAdded(captureId) {
  if (captures.some((c) => c.id === captureId)) return; // already have it
  const cap = await getCapture(captureId);
  if (!cap) return;
  captures.push(prep(cap));
  $("loading").classList.add("hidden");
  renderFilmstrip();
  setActive(captures.length - 1); // jump to the newest
}

// ---------------------------------------------------------------------------
// Filmstrip + active selection
// ---------------------------------------------------------------------------
function thumbSrc(cap) {
  if (cap.dataUrl) return cap.dataUrl;
  if (cap.blob) {
    if (!cap._thumbUrl) cap._thumbUrl = URL.createObjectURL(cap.blob);
    return cap._thumbUrl;
  }
  return "";
}

function renderFilmstrip() {
  const strip = $("filmstrip");
  strip.innerHTML = "";
  captures.forEach((cap, i) => {
    const item = document.createElement("div");
    item.className = "thumb" + (i === activeIndex ? " active" : "");
    item.onclick = () => setActive(i);

    if (cap.kind === "video") {
      const v = document.createElement("div");
      v.className = "thumb-video";
      v.textContent = "🎥";
      item.appendChild(v);
    } else {
      const img = document.createElement("img");
      img.src = thumbSrc(cap);
      img.alt = "";
      item.appendChild(img);
    }

    const num = document.createElement("span");
    num.className = "thumb-num";
    num.textContent = String(i + 1);
    item.appendChild(num);

    const del = document.createElement("button");
    del.className = "thumb-del";
    del.textContent = "×";
    del.title = "Remove from report";
    del.onclick = (e) => {
      e.stopPropagation();
      removeCapture(i);
    };
    item.appendChild(del);

    strip.appendChild(item);
  });

  const n = captures.length;
  $("filmstrip-hint").textContent = n
    ? `${n} capture${n > 1 ? "s" : ""} in this report — take more from the toolbar and they'll be added here.`
    : "";
}

function setActive(i) {
  if (i < 0 || i >= captures.length) return;
  // Stash the caption being edited before we switch away.
  if (activeIndex >= 0 && captures[activeIndex]) {
    captures[activeIndex].caption = $("caption").value;
  }
  activeIndex = i;
  const cap = captures[i];
  $("caption").value = cap.caption || "";
  document.querySelectorAll("#filmstrip .thumb").forEach((el, idx) =>
    el.classList.toggle("active", idx === i)
  );
  showPreview(cap);
  renderDiagnostics(cap);
  if (cap.note) setSubmitStatus("⚠ " + cap.note, "err");
}

async function removeCapture(i) {
  const cap = captures[i];
  captures.splice(i, 1);
  if (cap._thumbUrl) URL.revokeObjectURL(cap._thumbUrl);

  try {
    if (draftId) {
      const d = await getDraft(draftId);
      if (d) {
        d.captureIds = d.captureIds.filter((id) => id !== cap.id);
        await putDraft(d);
      }
    }
    await deleteCapture(cap.id);
  } catch (_) {}

  if (!captures.length) {
    activeIndex = -1;
    canvas.classList.add("hidden");
    $("video").classList.add("hidden");
    $("caption-bar").classList.add("hidden");
    fail("No captures left. Capture something to add it here.");
    renderFilmstrip();
    return;
  }
  // activeIndex may now point past the end or at a shifted item; reselect.
  activeIndex = -1;
  renderFilmstrip();
  setActive(Math.min(i, captures.length - 1));
}

// ---------------------------------------------------------------------------
// Preview (image → canvas, video → <video>)
// ---------------------------------------------------------------------------
function showPreview(cap) {
  if (objUrl) {
    URL.revokeObjectURL(objUrl);
    objUrl = null;
  }
  const v = $("video");
  $("caption-bar").classList.remove("hidden");

  if (cap.kind === "video") {
    $("anno-toolbar").classList.add("hidden");
    canvas.classList.add("hidden");
    const blob = cap.blob || new Blob([], { type: cap.mimeType });
    objUrl = URL.createObjectURL(blob);
    v.src = objUrl;
    v.classList.remove("hidden");
    return;
  }

  v.classList.add("hidden");
  v.removeAttribute("src");
  $("anno-toolbar").classList.remove("hidden");

  baseImage = new Image();
  baseImage.onload = () => {
    canvas.width = baseImage.naturalWidth;
    canvas.height = baseImage.naturalHeight;
    canvas.classList.remove("hidden");
    redraw();
  };
  baseImage.onerror = () => fail("Failed to load screenshot image.");
  if (cap.dataUrl) {
    baseImage.src = cap.dataUrl;
  } else if (cap.blob) {
    objUrl = URL.createObjectURL(cap.blob);
    baseImage.src = objUrl;
  } else {
    fail("Capture has no image data.");
  }
}

// ---------------------------------------------------------------------------
// Annotation engine — operates on the active capture's `shapes`
// ---------------------------------------------------------------------------
function activeCap() {
  return activeIndex >= 0 ? captures[activeIndex] : null;
}

function wireAnnotation() {
  document.querySelectorAll("#tools .tool").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll("#tools .tool").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      tool.tool = b.dataset.tool;
      canvas.dataset.tool = tool.tool;
    };
  });
  canvas.dataset.tool = tool.tool;

  document.querySelectorAll("#colors .swatch").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll("#colors .swatch").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      tool.color = b.dataset.color;
    };
  });

  $("undo").onclick = () => {
    const c = activeCap();
    if (c) {
      c.shapes.pop();
      redraw();
    }
  };
  $("clear").onclick = () => {
    const c = activeCap();
    if (c) {
      c.shapes = [];
      redraw();
    }
  };

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
  if (tool.tool === "select" || !activeCap()) return;
  const p = toCanvasCoords(e);

  if (tool.tool === "text") {
    promptText(p, e.clientX, e.clientY);
    return;
  }

  tool.drawing = true;
  tool.start = p;
  if (tool.tool === "pen") {
    tool.current = { tool: "pen", color: tool.color, size: tool.size, points: [p] };
  } else {
    tool.current = { tool: tool.tool, color: tool.color, size: tool.size, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  }
}

function onMove(e) {
  if (!tool.drawing) return;
  const p = toCanvasCoords(e);
  if (tool.tool === "pen") {
    tool.current.points.push(p);
  } else {
    tool.current.x1 = p.x;
    tool.current.y1 = p.y;
  }
  redraw();
}

function onUp() {
  if (!tool.drawing) return;
  tool.drawing = false;
  const c = activeCap();
  if (tool.current && c) {
    const s = tool.current;
    const tiny = s.tool !== "pen" && Math.abs(s.x1 - s.x0) < 3 && Math.abs(s.y1 - s.y0) < 3;
    if (!tiny) c.shapes.push(s);
  }
  tool.current = null;
  redraw();
}

function promptText(p, clientX, clientY) {
  const input = $("text-input");
  input.classList.remove("hidden");
  input.style.left = clientX + "px";
  input.style.top = clientY + "px";
  input.style.color = tool.color;
  input.value = "";
  input.focus();

  const commit = () => {
    const text = input.value.trim();
    input.classList.add("hidden");
    input.onblur = null;
    input.onkeydown = null;
    const c = activeCap();
    if (text && c) {
      c.shapes.push({ tool: "text", color: tool.color, x: p.x, y: p.y, text, size: 22 });
      redraw();
    }
  };
  input.onblur = commit;
  input.onkeydown = (ev) => {
    if (ev.key === "Enter") commit();
    if (ev.key === "Escape") {
      input.classList.add("hidden");
      input.onblur = null;
    }
  };
}

function redraw() {
  if (!baseImage) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(baseImage, 0, 0);
  const c = activeCap();
  const shapes = c ? c.shapes : [];
  const all = tool.current ? shapes.concat([tool.current]) : shapes;
  for (const s of all) drawShape(ctx, s, baseImage);
}

function drawShape(g, s, baseImg) {
  g.save();
  g.strokeStyle = s.color;
  g.fillStyle = s.color;
  g.lineWidth = s.size || 4;
  g.lineJoin = "round";
  g.lineCap = "round";

  if (s.tool === "rect") {
    g.strokeRect(Math.min(s.x0, s.x1), Math.min(s.y0, s.y1), Math.abs(s.x1 - s.x0), Math.abs(s.y1 - s.y0));
  } else if (s.tool === "arrow") {
    drawArrow(g, s.x0, s.y0, s.x1, s.y1, s.size || 4);
  } else if (s.tool === "pen") {
    g.beginPath();
    s.points.forEach((pt, i) => (i ? g.lineTo(pt.x, pt.y) : g.moveTo(pt.x, pt.y)));
    g.stroke();
  } else if (s.tool === "text") {
    g.font = `bold ${s.size || 22}px -apple-system, sans-serif`;
    g.textBaseline = "top";
    g.lineWidth = 4;
    g.strokeStyle = "rgba(255,255,255,.9)";
    g.strokeText(s.text, s.x, s.y);
    g.fillStyle = s.color;
    g.fillText(s.text, s.x, s.y);
  } else if (s.tool === "blur") {
    const x = Math.min(s.x0, s.x1), y = Math.min(s.y0, s.y1);
    const w = Math.abs(s.x1 - s.x0), h = Math.abs(s.y1 - s.y0);
    if (w > 1 && h > 1 && baseImg) {
      g.save();
      g.beginPath();
      g.rect(x, y, w, h);
      g.clip();
      g.filter = "blur(12px)";
      g.drawImage(baseImg, 0, 0);
      g.restore();
    }
  }
  g.restore();
}

function drawArrow(g, x0, y0, x1, y1, size) {
  const head = Math.max(12, size * 3);
  const ang = Math.atan2(y1 - y0, x1 - x0);
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.stroke();
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x1 - head * Math.cos(ang - Math.PI / 6), y1 - head * Math.sin(ang - Math.PI / 6));
  g.lineTo(x1 - head * Math.cos(ang + Math.PI / 6), y1 - head * Math.sin(ang + Math.PI / 6));
  g.closePath();
  g.fill();
}

// Flatten a capture's annotations onto its image and return a PNG blob.
function flattenCapture(cap) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const cx = c.getContext("2d");
      cx.drawImage(img, 0, 0);
      for (const s of cap.shapes) drawShape(cx, s, img);
      c.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/png");
    };
    img.onerror = () => reject(new Error("Could not load image for flattening."));
    if (cap.dataUrl) img.src = cap.dataUrl;
    else if (cap.blob) img.src = URL.createObjectURL(cap.blob);
    else reject(new Error("Capture has no image data."));
  });
}

// ---------------------------------------------------------------------------
// Diagnostics (per active capture)
// ---------------------------------------------------------------------------
function renderDiagnostics(cap) {
  const m = cap.meta || {};
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

  const logs = cap.logs || [];
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
  const m = (captures[0] && captures[0].meta) || {};
  const host = (() => {
    try {
      return new URL(m.url).host;
    } catch (_) {
      return "";
    }
  })();
  if (host && !$("title").value) $("title").value = `Bug on ${host}`;
}

async function loadLinear() {
  const { linearApiKey, defaultTeamId, defaultProjectId, defaultPriority, defaultStateId } =
    await chrome.storage.local.get(["linearApiKey", "defaultTeamId", "defaultProjectId", "defaultPriority", "defaultStateId"]);

  prefillForm();

  if (!linearApiKey) {
    $("no-key-warn").classList.remove("hidden");
    $("open-options").onclick = (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    };
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
  $("new-report").onclick = async () => {
    await send({ type: "NEW_DRAFT" }).catch(() => {});
    setSubmitStatus("Started a new report — new captures won't be added to this tab.", "");
  };
}

async function onSubmit() {
  // Persist the caption currently being edited.
  if (activeIndex >= 0 && captures[activeIndex]) {
    captures[activeIndex].caption = $("caption").value;
  }

  const teamId = $("team").value;
  const title = $("title").value.trim();
  if (!teamId) return setSubmitStatus("Pick a team.", "err");
  if (!title) return setSubmitStatus("Add a title.", "err");
  if (!captures.length) return setSubmitStatus("Add at least one capture.", "err");

  $("submit").disabled = true;
  setSubmitStatus("Uploading captures & creating issue…", "busy");

  try {
    // Flatten annotations into each annotated screenshot before upload.
    for (const cap of captures) {
      if (cap.kind === "image" && cap.shapes && cap.shapes.length) {
        const blob = await flattenCapture(cap);
        cap.blob = blob;
        cap.dataUrl = await blobToDataUrl(blob);
        await putCapture({
          id: cap.id,
          kind: cap.kind,
          blob: cap.blob,
          dataUrl: cap.dataUrl,
          mimeType: cap.mimeType,
          createdAt: cap.createdAt,
          meta: cap.meta,
          logs: cap.logs,
          note: cap.note || null,
        });
      }
    }

    const labelIds = Array.from($("labels").selectedOptions).map((o) => o.value);
    const items = captures.map((c) => ({ captureId: c.id, caption: c.caption || "" }));

    const resp = await send({
      type: "CREATE_TICKET",
      draftId,
      title,
      description: $("description").value,
      teamId,
      projectId: $("project").value || null,
      stateId: $("state").value || null,
      priority: Number($("priority").value || 0),
      labelIds,
      includeAttachments: $("include-attachment").checked,
      items,
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
  if (objUrl) URL.revokeObjectURL(objUrl);
  captures.forEach((c) => c._thumbUrl && URL.revokeObjectURL(c._thumbUrl));
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
